import { describe, expect, test } from 'bun:test'
import type { LoadedBlueprint } from '../blueprint/types.ts'
import type { ModelPrice } from '../deployment/types.ts'
import { createFakeProvider } from '../model/fake.ts'
import type { ChatRequest, Provider } from '../model/types.ts'
import { createTestBlueprint } from '../test-support/blueprint.ts'
import { createBarrier, createCounterClock, delay } from '../test-support/clock.ts'
import { call, toolCallResponse } from '../test-support/model.ts'
import { createFakeRegistry } from '../test-support/providers.ts'
import { createRunControl } from '../runs/control.ts'
import { createFakeWorktrees, type FakeWorktrees } from '../test-support/worktrees.ts'
import { createToolRegistry } from '../tools/registry.ts'
import type { ToolRegistry } from '../tools/types.ts'
import { createScheduler } from './run.ts'
import type { RunEvent } from '../runs/events.ts'
import type { RunResult } from './types.ts'

interface RunHarness {
	readonly run: (request: { runId: string; task: string }) => Promise<RunResult>
	readonly events: RunEvent[]
	readonly worktrees: FakeWorktrees
}

function createRun(options: {
	readonly blueprint: LoadedBlueprint
	readonly provider: Provider
	readonly worktrees?: FakeWorktrees
	readonly tools?: ToolRegistry
	readonly now?: () => number
	readonly prices?: Readonly<Record<string, ModelPrice>>
	readonly modelOverrides?: Readonly<Record<string, string>>
}): RunHarness {
	const events: RunEvent[] = []
	const worktrees = options.worktrees ?? createFakeWorktrees()
	const scheduler = createScheduler(
		{
			providers: createFakeRegistry(options.provider),
			tools: options.tools ?? createToolRegistry([]),
			worktrees,
			blueprint: options.blueprint,
			now: options.now ?? createCounterClock(),
			monotonicNow: createCounterClock(),
			sleep: async () => {},
			events: (event) => events.push(event),
			control: createRunControl(),
		},
		{
			repoPath: '/repo',
			prices: options.prices ?? {},
			modelOverrides: options.modelOverrides ?? {},
			approvals: [],
		},
	)
	return { run: (request) => scheduler.run(request), events, worktrees }
}

/** The system prompt carries the role's identity, so a fake can tell roles apart. */
function systemOf(request: ChatRequest): string {
	return request.messages[0]?.content ?? ''
}

// $3 per million prompt tokens, $15 per million completion tokens.
const PRICE: ModelPrice = { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 }
const EXPENSIVE_USAGE = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }

function sawToolResult(request: ChatRequest): boolean {
	return request.messages.some((message) => message.role === 'tool')
}

describe('createScheduler', () => {
	test('runs the entry role and records it', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [], isolation: 'shared' } })
		const harness = createRun({ blueprint, provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'all done' })])]) })

		const result = await harness.run({ runId: 'run-1', task: 'do it' })

		expect(result.card).toEqual({ status: 'success', summary: 'all done' })
		expect(result.baseSha).toBe('base0000')
		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]?.role).toBe('orchestrator')
		expect(result.agents[0]?.depth).toBe(0)
		expect(harness.events.map((event) => event.type)).toEqual(['agent_start', 'model_call', 'tool_call', 'agent_finish'])
	})

	test('runs sibling agents concurrently', async () => {
		const barrier = createBarrier(4)
		const blueprint = createTestBlueprint(
			{
				orchestrator: { tools: ['agent'], maxChildren: 4, isolation: 'shared' },
				worker: { tools: [], isolation: 'shared' },
			},
			{ maxConcurrentAgents: 4, maxAgentDepth: 3 },
		)

		const provider = createFakeProvider(async (request) => {
			if (systemOf(request).includes('worker')) {
				// Every worker blocks until all four have arrived. Work that were
				// serialized would never reach the count, and the test would time out.
				await barrier.arrive()
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: 'worker done' })])
			}
			if (!sawToolResult(request)) {
				return toolCallResponse(
					[0, 1, 2, 3].map((index) => call(`c${index}`, 'agent', { role: 'worker', task: `task ${index}` })),
				)
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'all workers done' })])
		})

		const result = await createRun({ blueprint, provider }).run({ runId: 'run-1', task: 'fan out' })

		const workers = result.agents.filter((agent) => agent.role === 'worker')
		expect(workers).toHaveLength(4)

		// Concurrency is proven by overlapping intervals, never by wall-clock time.
		for (const left of workers) {
			for (const right of workers) {
				if (left === right) continue
				expect(left.startedAt < right.finishedAt).toBe(true)
				expect(right.startedAt < left.finishedAt).toBe(true)
			}
		}
	})

	test('records agents in spawn order, not completion order', async () => {
		const blueprint = createTestBlueprint(
			{
				orchestrator: { tools: ['agent'], maxChildren: 4, isolation: 'shared' },
				worker: { tools: [], isolation: 'shared' },
			},
			{ maxConcurrentAgents: 4, maxAgentDepth: 3 },
		)

		const provider = createFakeProvider(async (request) => {
			if (systemOf(request).includes('worker')) {
				const task = request.messages[1]?.content ?? ''
				const index = Number(task.replace(/\D/g, '')) || 0
				// Earlier workers finish last, so completion order is reversed.
				await delay((4 - index) * 5)
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: task })])
			}
			if (!sawToolResult(request)) {
				return toolCallResponse(
					[0, 1, 2, 3].map((index) => call(`c${index}`, 'agent', { role: 'worker', task: `task ${index}` })),
				)
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const result = await createRun({ blueprint, provider }).run({ runId: 'run-1', task: 'go' })

		const workers = result.agents.filter((agent) => agent.role === 'worker')
		expect(workers.map((worker) => worker.agentId)).toEqual(['worker-1-2', 'worker-1-3', 'worker-1-4', 'worker-1-5'])

		// The same four, ordered by when they finished, come out in a different
		// order — which is exactly what the record must not depend on.
		const byCompletion = [...workers]
			.sort((left, right) => left.finishedAt - right.finishedAt)
			.map((worker) => worker.agentId)
		expect(byCompletion).not.toEqual(workers.map((worker) => worker.agentId))
	})

	test('a child’s committed work is integrated into its caller’s workspace', async () => {
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], maxChildren: 1 },
			worker: { tools: [], isolation: 'worktree' },
		})

		const provider = createFakeProvider((request) => {
			if (systemOf(request).includes('worker')) {
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: 'done' })])
			}
			if (!sawToolResult(request)) return toolCallResponse([call('c', 'agent', { role: 'worker', task: 'work' })])
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const harness = createRun({ blueprint, provider })
		await harness.run({ runId: 'run-1', task: 'go' })

		// Into the caller's tree — not the base repository, which is what a
		// `shared` role used to be handed and why review was impossible.
		expect(harness.worktrees.integrated).toEqual([
			'loom/run-1/worker-1-2 -> /repo/.loom/worktrees/run-1/orchestrator-0-1 [refuse]',
		])
		expect(harness.events.filter((event) => event.type === 'integration')).toEqual([
			{
				type: 'integration',
				agentId: 'worker-1-2',
				branch: 'loom/run-1/worker-1-2',
				into: '/repo/.loom/worktrees/run-1/orchestrator-0-1',
				status: 'merged',
				message: '',
			},
		])
	})

	test('a retry replaces the attempt it supersedes rather than losing to it', async () => {
		// The reproduction, reduced: the orchestrator asked for the same thing twice,
		// both attempts committed, and merging both conflicted — so the more
		// persistent the loop, the less able it was to deliver.
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], maxChildren: 1 },
			worker: { tools: [], isolation: 'worktree' },
		})

		let turns = 0
		const provider = createFakeProvider((request) => {
			if (systemOf(request).includes('worker')) {
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: 'done' })])
			}
			if (!sawToolResult(request)) return toolCallResponse([call('c1', 'agent', { role: 'worker', task: 'the same work' })])

			turns += 1
			if (turns === 1) return toolCallResponse([call('c2', 'agent', { role: 'worker', task: 'the same work' })])
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const harness = createRun({ blueprint, provider })
		await harness.run({ runId: 'run-1', task: 'go' })

		expect(harness.worktrees.integrated).toEqual([
			'loom/run-1/worker-1-2 -> /repo/.loom/worktrees/run-1/orchestrator-0-1 [refuse]',
			'loom/run-1/worker-1-3 -> /repo/.loom/worktrees/run-1/orchestrator-0-1 [incoming]',
		])
	})

	test('a role that failed does not have its work carried to the caller', async () => {
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], maxChildren: 1 },
			worker: { tools: [], isolation: 'worktree' },
		})

		const provider = createFakeProvider((request) => {
			// The worker finishes with an error and no summary of real work — the same
			// shape the reproduction had: a failed role with work committed.
			if (systemOf(request).includes('worker')) {
				return toolCallResponse([call('w', 'finish', { status: 'error', summary: 'gave up' })])
			}
			if (!sawToolResult(request)) return toolCallResponse([call('c', 'agent', { role: 'worker', task: 'work' })])
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const harness = createRun({ blueprint, provider })
		const result = await harness.run({ runId: 'run-1', task: 'go' })

		const worker = result.agents.find((agent) => agent.role === 'worker')
		expect(worker?.card.status).toBe('error')
		expect(worker?.sha).not.toBeNull()
		// The commit exists and stays on its own branch: three failed coders were
		// having their work folded into the caller's tree and then merged.
		expect(harness.worktrees.integrated).toEqual([])
	})

	test('a shared role works in its caller’s tree, not the base repository', async () => {
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], maxChildren: 1 },
			// A worktree child of a shared child: its integration target is the
			// shared child's workspace, which must be the orchestrator's tree.
			reviewer: { tools: ['agent'], maxChildren: 1, isolation: 'shared' },
			worker: { tools: [], isolation: 'worktree' },
		})

		const provider = createFakeProvider((request) => {
			const system = systemOf(request)
			if (system.includes('worker')) {
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: 'done' })])
			}
			if (system.includes('reviewer')) {
				if (!sawToolResult(request)) return toolCallResponse([call('c', 'agent', { role: 'worker', task: 'work' })])
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
			}
			if (!sawToolResult(request)) return toolCallResponse([call('r', 'agent', { role: 'reviewer', task: 'review' })])
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const harness = createRun({ blueprint, provider })
		await harness.run({ runId: 'run-1', task: 'go' })

		// The worker is the reviewer's child, and the reviewer shares the
		// orchestrator's tree — so that is where the worker's work lands.
		expect(harness.worktrees.integrated).toEqual([
			'loom/run-1/worker-2-3 -> /repo/.loom/worktrees/run-1/orchestrator-0-1 [refuse]',
		])
	})

	test('a caller is told when its child’s work could not be integrated', async () => {
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], maxChildren: 1 },
			worker: { tools: [], isolation: 'worktree' },
		})

		const provider = createFakeProvider((request) => {
			if (systemOf(request).includes('worker')) {
				return toolCallResponse([call('w', 'finish', { status: 'success', summary: 'done' })])
			}
			if (!sawToolResult(request)) return toolCallResponse([call('c', 'agent', { role: 'worker', task: 'work' })])

			// The caller can act on the conflict only if it can see it, so the run
			// succeeds only when the delegation result carries it.
			const seen = request.messages
				.filter((message) => message.role === 'tool')
				.map((message) => message.content)
				.join('\n')
			const told = seen.includes('"kind":"conflict"')
			return toolCallResponse([
				call('f', 'finish', { status: told ? 'success' : 'error', summary: told ? 'saw the conflict' : 'not told' }),
			])
		})

		const harness = createRun({ blueprint, provider, worktrees: createFakeWorktrees({ integrationConflict: true }) })
		const result = await harness.run({ runId: 'run-1', task: 'go' })

		expect(result.card.summary).toBe('saw the conflict')
	})

	test('refuses a delegation past the depth limit and logs the refusal', async () => {
		const blueprint = createTestBlueprint(
			{
				orchestrator: { tools: ['agent'], maxChildren: 1, isolation: 'shared' },
				worker: { tools: ['agent'], maxChildren: 1, isolation: 'shared' },
			},
			{ maxAgentDepth: 1 },
		)
		const provider = createFakeProvider((request) => {
			if (!sawToolResult(request)) return toolCallResponse([call('d', 'agent', { role: 'worker', task: 'deeper' })])
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		const harness = createRun({ blueprint, provider })
		const result = await harness.run({ runId: 'run-1', task: 'go' })

		// Depth 0 is the orchestrator, depth 1 is the worker; depth 2 is refused.
		expect(result.agents.map((agent) => agent.depth)).toEqual([0, 1])

		const refusal = harness.events.find((event) => event.type === 'error' && event.kind === 'depth_exceeded')
		expect(refusal).toBeDefined()
		if (refusal?.type === 'error') expect(refusal.message).toContain('exceeds the limit')
	})

	test('refuses a delegation to a role that does not exist', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: ['agent'], isolation: 'shared' } })
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'agent', { role: 'ghost', task: 'x' })]),
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'handled' })]),
		])

		const harness = createRun({ blueprint, provider })
		await harness.run({ runId: 'run-1', task: 'go' })

		expect(harness.events.some((event) => event.type === 'error' && event.kind === 'role_not_found')).toBe(true)
	})

	test('lists the Blueprint’s roles on the agent tool, so a delegation names a real one', async () => {
		// A model that has to guess a role name invents a plausible one — a run
		// asked for `reader`, got `role_not_found`, and burned a turn on it. The
		// tool it is about to call is where the list belongs.
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], isolation: 'shared' },
			coder: { tools: [], isolation: 'shared' },
			reviewer: { tools: [], isolation: 'shared' },
		})
		let seen: ChatRequest | undefined
		const provider = createFakeProvider((request) => {
			seen = request
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
		})

		await createRun({ blueprint, provider }).run({ runId: 'run-1', task: 'go' })

		const agentTool = seen?.tools.find((tool) => tool.name === 'agent')
		expect(agentTool?.description).toContain('orchestrator')
		expect(agentTool?.description).toContain('coder')
		expect(agentTool?.description).toContain('reviewer')
	})

	test('records a branch and a commit for every worktree-isolated agent', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [] } })
		const worktrees = createFakeWorktrees()

		const result = await createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])]),
			worktrees,
		}).run({ runId: 'run-1', task: 'go' })

		expect(result.agents[0]?.branch).toBe('loom/run-1/orchestrator-0-1')
		expect(result.agents[0]?.sha).toBe('sha1')
		expect(worktrees.committed).toEqual(['orchestrator-0-1'])
	})

	test('a child branches from its caller, not from where the run began', async () => {
		// Work flows *up* the delegation tree: a child's branch is merged into its
		// caller, so the caller is carrying its children's work. Nothing flowed
		// down, though — every child branched from the run's base and could see
		// none of it.
		//
		// A benchmark run showed what that costs. An agent told to *run the tests*
		// found them failing, because the fix was on a branch it could not see. It
		// fixed the bug again, committed that, and conflicted with the fix it had
		// just duplicated. The caller answered the conflict with another agent,
		// which did the same thing: thirteen agents and two hundred model calls on
		// one file, none of it converging.
		const blueprint = createTestBlueprint(
			{ orchestrator: { tools: ['agent'], isolation: 'worktree' }, worker: { tools: [], isolation: 'worktree' } },
			{ maxAgentDepth: 2 },
		)
		const provider = createFakeProvider((request) =>
			sawToolResult(request)
				? toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
				: toolCallResponse([call('d', 'agent', { role: 'worker', task: 'look at it' })]),
		)
		const worktrees = createFakeWorktrees({ baseSha: 'base0000', callerHead: 'callerhead' })

		await createRun({ blueprint, provider, worktrees }).run({ runId: 'run-1', task: 'go' })

		// The root is where the run pinned it; the child follows the caller, which
		// has moved since.
		expect(worktrees.createdFrom).toEqual(['orchestrator-0-1@base0000', 'worker-1-2@callerhead'])
	})

	test('an agent that changes nothing records no commit', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [] } })

		const result = await createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'nothing to do' })])]),
			worktrees: createFakeWorktrees({ dirty: false }),
		}).run({ runId: 'run-1', task: 'go' })

		expect(result.agents[0]?.sha).toBeNull()
	})

	test('a tool that throws does not take the run down', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: ['explode'], isolation: 'shared' } })
		const tools = createToolRegistry([
			{
				name: 'explode',
				run: async () => {
					throw new Error('tool exploded')
				},
			},
		])
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'explode', {})]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'recovered' })])
			},
		])

		const result = await createRun({ blueprint, provider, tools }).run({ runId: 'run-1', task: 'go' })

		expect(result.card).toEqual({ status: 'success', summary: 'recovered' })
		expect(second?.messages.find((message) => message.role === 'tool')?.content).toContain('tool exploded')
	})

	test('records which model served each agent, and what it cost', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [], isolation: 'shared' } })
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })], EXPENSIVE_USAGE)]),
			prices: { 'test-model': PRICE },
		})

		await harness.run({ runId: 'run-1', task: 'go' })

		const finish = harness.events.find((event) => event.type === 'agent_finish')
		if (finish?.type !== 'agent_finish') throw new Error('no agent finished')
		expect(finish.model).toBe('test-model')
		expect(finish.costUsd).toBeCloseTo(18, 10)
	})

	test('crossing an alert threshold emits an event and lets the run finish', async () => {
		const blueprint = createTestBlueprint(
			{ orchestrator: { tools: [], isolation: 'shared' } },
			{ alerts: { costUsd: 1 } },
		)
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })], EXPENSIVE_USAGE)]),
			prices: { 'test-model': PRICE },
		})

		const result = await harness.run({ runId: 'run-1', task: 'go' })

		// The run finished: an alert is a signal to look, never a stop.
		expect(result.card.status).toBe('success')

		const alert = harness.events.find((event) => event.type === 'alert')
		if (alert?.type !== 'alert') throw new Error('no alert fired')
		expect(alert.kind).toBe('cost')
		expect(alert.threshold).toBe(1)
		expect(alert.actual).toBeCloseTo(18, 10)
	})

	test('an alert fires once, however many agents cross it', async () => {
		const blueprint = createTestBlueprint(
			{
				orchestrator: { tools: ['agent'], maxChildren: 2, isolation: 'shared' },
				worker: { tools: [], isolation: 'shared' },
			},
			{ alerts: { costUsd: 1 } },
		)
		const provider = createFakeProvider((request) => {
			if (systemOf(request).includes('worker')) {
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'worker done' })], EXPENSIVE_USAGE)
			}
			if (!sawToolResult(request)) {
				return toolCallResponse(
					[call('a', 'agent', { role: 'worker', task: 'x' }), call('b', 'agent', { role: 'worker', task: 'y' })],
					EXPENSIVE_USAGE,
				)
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'all done' })], EXPENSIVE_USAGE)
		})

		const harness = createRun({ blueprint, provider, prices: { 'test-model': PRICE } })
		await harness.run({ runId: 'run-1', task: 'go' })

		// Three agents, each far past the threshold — but one alert.
		expect(harness.events.filter((event) => event.type === 'alert')).toHaveLength(1)
	})

	test('a token alert fires on the run total', async () => {
		const blueprint = createTestBlueprint(
			{ orchestrator: { tools: [], isolation: 'shared' } },
			{ alerts: { tokens: 100 } },
		)
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })], EXPENSIVE_USAGE)]),
			prices: { 'test-model': PRICE },
		})

		await harness.run({ runId: 'run-1', task: 'go' })

		const alert = harness.events.find((event) => event.type === 'alert')
		if (alert?.type !== 'alert') throw new Error('no alert fired')
		expect(alert.kind).toBe('tokens')
	})

	test('a run with no alerts declared never emits one', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [], isolation: 'shared' } })
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })], EXPENSIVE_USAGE)]),
			prices: { 'test-model': PRICE },
		})

		await harness.run({ runId: 'run-1', task: 'go' })
		expect(harness.events.some((event) => event.type === 'alert')).toBe(false)
	})

	test('a model with no price in the map costs zero rather than crashing', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [], isolation: 'shared' } })
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })], EXPENSIVE_USAGE)]),
		})

		await harness.run({ runId: 'run-1', task: 'go' })

		const finish = harness.events.find((event) => event.type === 'agent_finish')
		if (finish?.type !== 'agent_finish') throw new Error('no agent finished')
		expect(finish.costUsd).toBe(0)
	})

	test('the entry role cannot report success while a writer succeeded and nothing verified it', async () => {
		// Both failing benchmark runs ended this way: tests red, orchestrator
		// reports success. The engine refuses the card and says what is missing.
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], isolation: 'shared' },
			coder: { tools: ['write_file'], isolation: 'worktree' },
		})
		let coderDone = false
		const provider = createFakeProvider((request) => {
			const system = systemOf(request)
			if (system.includes('You are coder.')) {
				coderDone = true
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'wrote it' })])
			}
			if (system.includes('You are orchestrator.')) {
				if (!coderDone) return toolCallResponse([call('a', 'agent', { role: 'coder', task: 'write the change' })])
				if (!sawToolResult(request)) return toolCallResponse([call('a2', 'agent', { role: 'coder', task: 'write more' })])
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'all done' })])
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: '?' })])
		})

		const harness = createRun({ blueprint, provider })
		await harness.run({ runId: 'run-1', task: 'go' })

		const refusal = harness.events.find((event) => event.type === 'error' && event.kind === 'unverified_success')
		expect(refusal).toBeDefined()
		// The orchestrator was told exactly what to do next, in the conversation.
		const last = harness.events.filter((event) => event.type === 'model_call')
		expect(last.length).toBeGreaterThan(1)
	})

	test('the gate refuses a success when research finished but no role ever wrote the change', async () => {
		// The expression-parser run: orchestrator + researcher only, no coder ever
		// delegated, and a finish card claiming "Implemented the parser". Nothing
		// was written, so there was nothing to verify — the claim itself is the
		// fiction the gate has to catch.
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], isolation: 'shared' },
			coder: { tools: [], isolation: 'worktree' },
		})
		const provider = createFakeProvider((request) => {
			const system = systemOf(request)
			if (system.includes('You are coder.')) {
				return toolCallResponse([call('f', 'finish', { status: 'error', summary: 'could not do it' })])
			}
			if (system.includes('You are orchestrator.')) {
				if (!sawToolResult(request)) {
					return toolCallResponse([call('a', 'agent', { role: 'coder', task: 'implement the parser' })])
				}
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'Implemented the parser. All tests should now pass.' })])
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: '?' })])
		})

		const harness = createRun({ blueprint, provider })
		const result = await harness.run({ runId: 'run-1', task: 'implement the parser' })

		expect(harness.events.some((event) => event.type === 'error' && event.kind === 'unverified_success')).toBe(true)
		// Bounded: the bounded refusal settles the run rather than looping.
		expect(result.card.status).toBe('error')
		expect(result.card.error?.kind).toBe('unverified_success')
	})

	test('the entry role reports success once a read-only role verified after the writer', async () => {
		const blueprint = createTestBlueprint({
			orchestrator: { tools: ['agent'], isolation: 'shared' },
			coder: { tools: ['write_file'], isolation: 'worktree' },
			reviewer: { tools: [], isolation: 'shared' },
		})
		const provider = createFakeProvider((request) => {
			const system = systemOf(request)
			if (system.includes('You are coder.')) {
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'wrote it' })])
			}
			if (system.includes('You are reviewer.')) {
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'checked it' })])
			}
			if (system.includes('You are orchestrator.')) {
				const asked = request.messages.filter((message) => message.role === 'tool').length
				if (asked === 0) return toolCallResponse([call('a1', 'agent', { role: 'coder', task: 'write the change' })])
				if (asked === 1) return toolCallResponse([call('a2', 'agent', { role: 'reviewer', task: 'review it' })])
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'verified and done' })])
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: '?' })])
		})

		const harness = createRun({ blueprint, provider })
		const result = await harness.run({ runId: 'run-1', task: 'go' })

		expect(result.card.status).toBe('success')
		expect(harness.events.some((event) => event.type === 'error' && event.kind === 'unverified_success')).toBe(false)
	})
})
