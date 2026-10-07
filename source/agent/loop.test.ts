import { describe, expect, test } from 'bun:test'
import { createFakeProvider } from '../model/fake.ts'
import type { ChatRequest, Provider } from '../model/types.ts'
import { createCounterClock, delay } from '../test-support/clock.ts'
import { call, textResponse, toolCallResponse } from '../test-support/model.ts'
import { createToolRegistry } from '../tools/registry.ts'
import type { ToolRegistry } from '../tools/types.ts'
import { runAgentLoop, type AgentLoopDependencies, type AgentLoopRequest } from './loop.ts'

const request: AgentLoopRequest = {
	agentId: 'test-0-1',
	systemPrompt: 'You are a test role.',
	task: 'do the thing',
	profile: { provider: 'test', model: 'test-model', temperature: 0 },
	toolSpecs: [],
	workspaceRoot: '/repo',
	maxTurns: 5,
	maxChildren: 2,
}

function dependencies(provider: Provider, tools: ToolRegistry = createToolRegistry([])): AgentLoopDependencies {
	return {
		provider,
		tools,
		delegate: async () => ({ status: 'success', summary: 'child done' }),
		events: () => {},
		now: createCounterClock(),
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

	test('a reply with no tool call is an implicit finish', async () => {
		const provider = createFakeProvider([textResponse('I did it')])
		const outcome = await runAgentLoop(dependencies(provider), request)
		expect(outcome.card).toEqual({ status: 'success', summary: 'I did it' })
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
			events: () => {},
			now: createCounterClock(),
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
			events: () => {},
			now: createCounterClock(),
		}

		await runAgentLoop(deps, { ...request, maxChildren: 2 })
		expect(peak).toBe(2)
	})

	test('a provider failure ends the role with an error card', async () => {
		const provider = createFakeProvider([{ kind: 'unavailable', message: 'endpoint down' }])
		const outcome = await runAgentLoop(dependencies(provider), request)
		expect(outcome.card.status).toBe('error')
		expect(outcome.card.error?.kind).toBe('unavailable')
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
})
