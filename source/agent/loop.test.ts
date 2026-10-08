import { describe, expect, test } from 'bun:test'
import { createFakeProvider } from '../model/fake.ts'
import type { ChatRequest, Provider } from '../model/types.ts'
import type { RunEvent } from '../runs/events.ts'
import { createRunControl } from '../runs/control.ts'
import { createCounterClock, delay } from '../test-support/clock.ts'
import { call, textResponse, toolCallResponse } from '../test-support/model.ts'
import { createToolRegistry } from '../tools/registry.ts'
import { createToolPolicy } from '../tools/policy.ts'
import type { ToolRegistry } from '../tools/types.ts'
import { runAgentLoop, type AgentLoopDependencies, type AgentLoopRequest } from './loop.ts'

const request: AgentLoopRequest = {
	agentId: 'test-0-1',
	systemPrompt: 'You are a test role.',
	task: 'do the thing',
	profile: { provider: 'test', model: 'test-model', temperature: 0 },
	toolSpecs: [],
	allowedTools: ['echo', 'boom', 'ghost', 'agent', 'finish'],
	workspaceRoot: '/repo',
	maxTurns: 5,
	maxChildren: 2,
}

function dependencies(provider: Provider, tools: ToolRegistry = createToolRegistry([])): AgentLoopDependencies {
	return {
		provider,
		tools,
		delegate: async () => ({ status: 'success', summary: 'child done' }),
		policy: createToolPolicy({ mode: 'workspace-write', requireApproval: [], approvals: [] }),
		control: createRunControl(),
		events: () => {},
		now: createCounterClock(),
		monotonicNow: createCounterClock(),
		sleep: async () => {},
	}
}

function lastToolMessage(request: ChatRequest | undefined): string {
	return request?.messages.find((message) => message.role === 'tool')?.content ?? ''
}

describe('runAgentLoop', () => {
	test('a finish call ends the role with its card', async () => {
		const provider = createFakeProvider([
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'all done', artifacts: ['a.ts'] })]),
		])
		const outcome = await runAgentLoop(dependencies(provider), request)
		expect(outcome.card).toEqual({ status: 'success', summary: 'all done', artifacts: ['a.ts'] })
		expect(outcome.turns).toBe(1)
	})

	test('a reply with no tool call is not a finish — the role is told to call finish', async () => {
		// Reading prose as a finish let a run report `success` having done nothing:
		// the orchestrator failed to delegate, said "I'll read the test files now",
		// and stopped. The engine cannot tell a conclusion from a statement of intent,
		// so it asks for the shape it can read.
		const provider = createFakeProvider((request) => {
			const nudged = request.messages.some((message) => message.content.includes('Call `finish`'))
			if (!nudged) return textResponse('I will read the test files now')
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'now I really did it' })])
		})

		const outcome = await runAgentLoop(dependencies(provider), request)
		expect(outcome.card).toEqual({ status: 'success', summary: 'now I really did it' })
	})

	test('a role that will not finish is called unfinished, and its words are kept', async () => {
		const provider = createFakeProvider(() => textResponse('let me think about it'))
		const outcome = await runAgentLoop(dependencies(provider), request)

		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('unfinished')
		// What it said is the only clue to why, so it is carried, not discarded.
		expect(outcome.card.summary).toContain('let me think about it')
	})

	test('a reply cut off at the output limit is refused, and its tool call never runs', async () => {
		// A truncated reply can carry a tool call that looks complete. Running it
		// would write half a file, so the whole reply is refused.
		let ran = 0
		const tools = createToolRegistry([
			{
				name: 'echo',
				run: async () => {
					ran += 1
					return { kind: 'success', data: null }
				},
			},
		])
		const provider = createFakeProvider([
			{
				kind: 'success',
				response: {
					content: '',
					toolCalls: [call('c1', 'echo', {})],
					usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
					finishReason: 'length',
				},
			},
		])

		const outcome = await runAgentLoop(dependencies(provider, tools), request)

		expect(ran).toBe(0)
		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('output_truncated')
	})

	test('dispatches a tool call and feeds its result back', async () => {
		const tools = createToolRegistry([{ name: 'echo', run: async (args) => ({ kind: 'success', data: args }) }])
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'echo', { value: 1 })]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])
			},
		])

		const outcome = await runAgentLoop(dependencies(provider, tools), request)

		expect(outcome.card.status).toBe('success')
		expect(lastToolMessage(second)).toBe(JSON.stringify({ kind: 'success', data: { value: 1 } }))
		expect(second?.messages.find((message) => message.role === 'tool')?.toolCallId).toBe('c1')
	})

	test('a tool that throws becomes a result the model can read', async () => {
		const tools = createToolRegistry([
			{
				name: 'boom',
				run: async () => {
					throw new Error('tool exploded')
				},
			},
		])
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'boom', {})]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'recovered' })])
			},
		])

		const outcome = await runAgentLoop(dependencies(provider, tools), request)

		expect(outcome.card.summary).toBe('recovered')
		expect(lastToolMessage(second)).toContain('tool exploded')
	})

	test('an unknown tool is reported to the model rather than thrown', async () => {
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'ghost', {})]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'ok' })])
			},
		])

		await runAgentLoop(dependencies(provider), request)
		expect(lastToolMessage(second)).toContain('unknown_tool')
	})

	test('a tool the role was not granted is refused, even though the engine has it', async () => {
		// `echo` is registered, but this role holds no grants — the capability
		// model must hold against a model that calls an ungranted tool anyway.
		const tools = createToolRegistry([{ name: 'echo', run: async () => ({ kind: 'success', data: 'ran' }) }])
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'echo', {})]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'ok' })])
			},
		])

		await runAgentLoop(dependencies(provider, tools), { ...request, allowedTools: [] })

		expect(lastToolMessage(second)).toContain('unknown_tool')
		expect(lastToolMessage(second)).toContain('is available to this role')
	})

	test('a malformed finish is reported back so the model can correct it', async () => {
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('f1', 'finish', { status: 'nonsense', summary: '' })]),
			(request) => {
				second = request
				return toolCallResponse([call('f2', 'finish', { status: 'success', summary: 'fixed' })])
			},
		])

		const outcome = await runAgentLoop(dependencies(provider), request)

		expect(outcome.card.summary).toBe('fixed')
		expect(lastToolMessage(second)).toContain('invalid_arguments')
	})

	test('delegates through the callback and carries the child card back', async () => {
		const provider = createFakeProvider([
			toolCallResponse([call('a1', 'agent', { role: 'worker', task: 'sub task' })]),
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'parent done' })]),
		])
		const seen: Array<{ role: string; task: string }> = []
		const deps: AgentLoopDependencies = {
			provider,
			tools: createToolRegistry([]),
			delegate: async (delegation) => {
				seen.push(delegation)
				return { status: 'success', summary: 'child says hi' }
			},
			policy: createToolPolicy({ mode: 'workspace-write', requireApproval: [], approvals: [] }),
			control: createRunControl(),
			events: () => {},
			now: createCounterClock(),
			monotonicNow: createCounterClock(),
			sleep: async () => {},
		}

		await runAgentLoop(deps, request)
		expect(seen).toEqual([{ role: 'worker', task: 'sub task' }])
	})

	test('runs delegations concurrently, bounded by the role ceiling', async () => {
		let active = 0
		let peak = 0
		const provider = createFakeProvider([
			toolCallResponse([0, 1, 2, 3, 4].map((index) => call(`c${index}`, 'agent', { role: 'worker', task: `t${index}` }))),
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })]),
		])
		const deps: AgentLoopDependencies = {
			provider,
			tools: createToolRegistry([]),
			delegate: async () => {
				active += 1
				peak = Math.max(peak, active)
				await delay(1)
				active -= 1
				return { status: 'success', summary: 'child' }
			},
			policy: createToolPolicy({ mode: 'workspace-write', requireApproval: [], approvals: [] }),
			control: createRunControl(),
			events: () => {},
			now: createCounterClock(),
			monotonicNow: createCounterClock(),
			sleep: async () => {},
		}

		await runAgentLoop(deps, { ...request, maxChildren: 2 })
		expect(peak).toBe(2)
	})

	test('a wall clock that steps backwards cannot make a turn duration negative', async () => {
		// A resumed VM or an NTP correction moves the wall clock backwards, and it
		// really happens — this was found in a run whose log timestamps went back
		// 2.5s mid-flight. A duration is measured on the monotonic clock for exactly
		// this reason; a negative latency is never a truthful answer.
		let wall = 1_700_000_000_000
		let monotonic = 0
		const provider = createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])])
		const events: RunEvent[] = []

		await runAgentLoop(
			{
				provider,
				tools: createToolRegistry([]),
				delegate: async () => ({ status: 'success', summary: 'child' }),
				policy: createToolPolicy({ mode: 'workspace-write', requireApproval: [], approvals: [] }),
				control: createRunControl(),
				// Every wall-clock reading is five seconds behind the last one.
				now: () => (wall -= 5_000),
				monotonicNow: () => (monotonic += 7),
				sleep: async () => {},
				events: (event) => events.push(event),
			},
			request,
		)

		const turn = events.find((event) => event.type === 'model_call')
		expect(turn?.type).toBe('model_call')
		expect(turn?.type === 'model_call' ? turn.durationMs : -1).toBe(7)
	})

	test('the role is told where its workspace is', async () => {
		// The one fact a role cannot infer and used to never be given: a model left to
		// guess recites /testbed or someone else's desktop path and spends its whole
		// turn budget discovering that the guess was wrong.
		const provider = createFakeProvider([toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })])])
		await runAgentLoop(dependencies(provider), { ...request, workspaceRoot: '/tmp/the-workspace' })

		const system = provider.calls[0]?.messages[0]?.content ?? ''
		expect(system).toContain('You are a test role.')
		expect(system).toContain('/tmp/the-workspace')
		expect(system).toContain('git repository')
	})

	test('a provider failure is retried, and the role carries on when the endpoint recovers', async () => {
		// A local server 500s on a tool call it cannot parse; a provider rate-limits.
		// A role that gave up on the first hiccup would make autonomy impossible.
		const provider = createFakeProvider([
			{ kind: 'unavailable', message: 'HTTP 500: failed to parse tool call arguments' },
			{ kind: 'unavailable', message: 'HTTP 500: failed to parse tool call arguments' },
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'recovered' })]),
		])
		const events: RunEvent[] = []
		const outcome = await runAgentLoop({ ...dependencies(provider), events: (event) => void events.push(event) }, request)

		expect(outcome.card.status).toBe('success')
		expect(outcome.card.summary).toBe('recovered')
		expect(events.filter((event) => event.type === 'model_retry').map((event) => event.attempt)).toEqual([1, 2])
	})

	test('a provider failure that keeps failing ends the role, bounded', async () => {
		const provider = createFakeProvider(() => ({ kind: 'unavailable', message: 'endpoint down' }))
		const events: RunEvent[] = []
		const outcome = await runAgentLoop({ ...dependencies(provider), events: (event) => void events.push(event) }, request)

		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('unavailable')
		// Bounded: a genuinely broken endpoint ends the role rather than the run.
		expect(events.filter((event) => event.type === 'model_retry')).toHaveLength(3)
	})

	test('an unparseable answer is not retried', async () => {
		// `invalid_response` means the provider answered with nonsense; asking the
		// same thing again does not fix that, so it fails on the first one.
		const provider = createFakeProvider(() => ({ kind: 'invalid_response', message: 'not JSON' }))
		const events: RunEvent[] = []
		const outcome = await runAgentLoop({ ...dependencies(provider), events: (event) => void events.push(event) }, request)

		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('invalid_response')
		expect(events.filter((event) => event.type === 'model_retry')).toHaveLength(0)
	})

	test('an empty answer is not a finish either — it is the same missing tool call', async () => {
		// This is how a coder came back "successful" having committed nothing: an
		// empty completion was read as the role finishing, and named "Completed.".
		const provider = createFakeProvider(() => textResponse(''))
		const outcome = await runAgentLoop(dependencies(provider), request)

		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('unfinished')
	})

	test('an empty answer followed by a real one is only a hiccup', async () => {
		const provider = createFakeProvider([
			textResponse(''),
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })]),
		])
		const outcome = await runAgentLoop(dependencies(provider), request)

		expect(outcome.card.status).toBe('success')
		expect(outcome.card.summary).toBe('done')
	})

	test('a role that never finishes hits its turn limit', async () => {
		const tools = createToolRegistry([{ name: 'echo', run: async () => ({ kind: 'success', data: null }) }])
		const provider = createFakeProvider(() => toolCallResponse([call('c', 'echo', {})]))

		const outcome = await runAgentLoop(dependencies(provider, tools), { ...request, maxTurns: 3 })

		expect(outcome.turns).toBe(3)
		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('turn_limit')
	})

	test('accumulates token usage across turns', async () => {
		const provider = createFakeProvider([
			toolCallResponse([call('f', 'finish', { status: 'success', summary: 'done' })]),
		])
		const outcome = await runAgentLoop(dependencies(provider), request)
		expect(outcome.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
		expect(outcome.startedAt).toBeLessThan(outcome.finishedAt)
	})

	test('a tool the run forbids is denied, and never reaches the handler', async () => {
		let invoked = 0
		const tools = createToolRegistry([
			{
				name: 'write_file',
				run: async () => {
					invoked += 1
					return { kind: 'success', data: null }
				},
			},
		])
		let second: ChatRequest | undefined
		const provider = createFakeProvider([
			toolCallResponse([call('c1', 'write_file', { path: 'a', content: 'b' })]),
			(request) => {
				second = request
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'ok' })])
			},
		])
		const events: RunEvent[] = []

		const outcome = await runAgentLoop(
			{
				provider,
				tools,
				policy: createToolPolicy({ mode: 'read-only', requireApproval: [], approvals: [] }),
				control: createRunControl(),
				delegate: async () => ({ status: 'success', summary: 'child' }),
				events: (event) => events.push(event),
				now: createCounterClock(),
				monotonicNow: createCounterClock(),
				sleep: async () => {},
			},
			{ ...request, allowedTools: ['write_file', 'finish'] },
		)

		// Asserted, not assumed: the handler was never reached.
		expect(invoked).toBe(0)
		expect(lastToolMessage(second)).toContain('permission_denied')

		// The denial is audited, not only returned, so an operator can find it later.
		expect(events.some((event) => event.type === 'error' && event.kind === 'permission_denied')).toBe(true)

		// And the run carries on rather than dying over a blocked command.
		expect(outcome.card.status).toBe('success')
	})
})
