import { describe, expect, test } from 'bun:test'
import type { LoadedBlueprint } from '../blueprint/types.ts'
import type { ModelPrice } from '../deployment/types.ts'
import { createFakeProvider } from '../model/fake.ts'
import type { ChatRequest, Provider } from '../model/types.ts'
import { createTestBlueprint } from '../test-support/blueprint.ts'
import { createBarrier, createCounterClock, delay } from '../test-support/clock.ts'
import { call, textResponse, toolCallResponse } from '../test-support/model.ts'
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
	const scheduler = createScheduler(
		{
			providers: createFakeRegistry(options.provider),
			tools: options.tools ?? createToolRegistry([]),
			worktrees: options.worktrees ?? createFakeWorktrees(),
			blueprint: options.blueprint,
			now: options.now ?? createCounterClock(),
			monotonicNow: createCounterClock(),
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
	return { run: (request) => scheduler.run(request), events }
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
		const harness = createRun({ blueprint, provider: createFakeProvider([textResponse('all done')]) })

		const result = await harness.run({ runId: 'run-1', task: 'do it' })

		expect(result.card).toEqual({ status: 'success', summary: 'all done' })
		expect(result.baseSha).toBe('base0000')
		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]?.role).toBe('orchestrator')
		expect(result.agents[0]?.depth).toBe(0)
		expect(harness.events.map((event) => event.type)).toEqual(['agent_start', 'model_call', 'agent_finish'])
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

	test('records a branch and a commit for every worktree-isolated agent', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [] } })
		const worktrees = createFakeWorktrees()

		const result = await createRun({
			blueprint,
			provider: createFakeProvider([textResponse('done')]),
			worktrees,
		}).run({ runId: 'run-1', task: 'go' })

		expect(result.agents[0]?.branch).toBe('loom/run-1/orchestrator-0-1')
		expect(result.agents[0]?.sha).toBe('sha1')
		expect(worktrees.committed).toEqual(['orchestrator-0-1'])
	})

	test('an agent that changes nothing records no commit', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [] } })

		const result = await createRun({
			blueprint,
			provider: createFakeProvider([textResponse('nothing to do')]),
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
			provider: createFakeProvider([textResponse('done', EXPENSIVE_USAGE)]),
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
			provider: createFakeProvider([textResponse('done', EXPENSIVE_USAGE)]),
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
			if (systemOf(request).includes('worker')) return textResponse('worker done', EXPENSIVE_USAGE)
			if (!sawToolResult(request)) {
				return toolCallResponse(
					[call('a', 'agent', { role: 'worker', task: 'x' }), call('b', 'agent', { role: 'worker', task: 'y' })],
					EXPENSIVE_USAGE,
				)
			}
			return textResponse('all done', EXPENSIVE_USAGE)
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
			provider: createFakeProvider([textResponse('done', EXPENSIVE_USAGE)]),
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
			provider: createFakeProvider([textResponse('done', EXPENSIVE_USAGE)]),
			prices: { 'test-model': PRICE },
		})

		await harness.run({ runId: 'run-1', task: 'go' })
		expect(harness.events.some((event) => event.type === 'alert')).toBe(false)
	})

	test('a model with no price in the map costs zero rather than crashing', async () => {
		const blueprint = createTestBlueprint({ orchestrator: { tools: [], isolation: 'shared' } })
		const harness = createRun({
			blueprint,
			provider: createFakeProvider([textResponse('done', EXPENSIVE_USAGE)]),
		})

		await harness.run({ runId: 'run-1', task: 'go' })

		const finish = harness.events.find((event) => event.type === 'agent_finish')
		if (finish?.type !== 'agent_finish') throw new Error('no agent finished')
		expect(finish.costUsd).toBe(0)
	})
})
