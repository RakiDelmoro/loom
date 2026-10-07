import { describe, expect, test } from 'bun:test'
import type { ModelPrice } from '../deployment/types.ts'
import { failed, ok, type OpResult } from '../result.ts'
import { createRunControl, type RunControl } from '../runs/control.ts'
import type { RunLogRecord } from '../runs/validate.ts'
import type { RunManifest } from '../runs/types.ts'
import { createTestAgent, createTestManifest } from '../test-support/runs.ts'
import type { SubmitRequest } from './service.ts'
import type { RunService } from './service.ts'
import { handleApi, type ApiRequest } from './routes.ts'

const PRICES: Readonly<Record<string, ModelPrice>> = {
	'test-model': { inputPer1M: 10, cachedInputPer1M: 1, outputPer1M: 20 },
}

interface FakeService extends RunService {
	readonly submitted: SubmitRequest[]
	readonly controlFor: (runId: string) => RunControl | undefined
	finish(runId: string): void
}

function createFakeService(options: { readonly diff?: OpResult<string> } = {}): FakeService {
	const manifests = new Map<string, RunManifest>()
	const logs = new Map<string, readonly RunLogRecord[]>()
	const controls = new Map<string, RunControl>()
	const submitted: SubmitRequest[] = []
	let activeRunId: string | null = null
	let counter = 0

	return {
		submitted,
		controlFor: (runId) => controls.get(runId),

		finish(runId) {
			controls.delete(runId)
			if (activeRunId === runId) activeRunId = null
		},

		submit(request) {
			if (activeRunId !== null) return failed('a run is already in progress')
			counter += 1
			const runId = `run-${String(counter)}`
			submitted.push(request)
			activeRunId = runId
			controls.set(runId, createRunControl())
			manifests.set(runId, createTestManifest({ runId, task: request.task, status: 'running', finishedAt: null }))
			logs.set(runId, [
				{ index: 0, at: '2026-01-01T00:00:00.000Z', type: 'run_started', event: { type: 'run_started', runId } },
				{ index: 1, at: '2026-01-01T00:00:01.000Z', type: 'agent_start', event: { type: 'agent_start', agentId: 'a' } },
			])
			return ok({ runId })
		},

		active: () => activeRunId,
		control: (runId) => (activeRunId === runId ? controls.get(runId) ?? null : null),
		list: () => [...manifests.values()],
		manifest: (runId) => manifests.get(runId) ?? null,
		events: (runId) => logs.get(runId) ?? [],
		diff: () => options.diff ?? ok('--- a\n+++ b\n'),
		merge: (_runId, agentId) => (agentId === 'ghost' ? failed('no agent "ghost"') : ok('mergesha')),
		undo: () => ok('base0000'),
	}
}

function get(pathname: string, query = ''): ApiRequest {
	return { method: 'GET', pathname, query: new URLSearchParams(query), body: null }
}

function post(pathname: string, body: unknown): ApiRequest {
	return { method: 'POST', pathname, query: new URLSearchParams(), body }
}

function routes(service: RunService) {
	return { service, prices: PRICES, defaultAutonomy: 'auto' as const }
}

describe('the API routes', () => {
	test('an unknown path is a 404 that names the path', () => {
		const response = handleApi(get('/api/nope'), routes(createFakeService()))
		expect(response.status).toBe(404)
		expect(response.body).toEqual({ error: 'no route for /api/nope' })
	})

	test('health reports the active run', () => {
		const service = createFakeService()
		expect(handleApi(get('/api/health'), routes(service)).body).toEqual({ ok: true, activeRunId: null })
		service.submit({ task: 'x', autonomy: 'auto' })
		expect(handleApi(get('/api/health'), routes(service)).body).toEqual({ ok: true, activeRunId: 'run-1' })
	})

	test('submitting needs a task', () => {
		const service = createFakeService()
		const response = handleApi(post('/api/runs', { autonomy: 'auto' }), routes(service))
		expect(response.status).toBe(400)
		expect(service.submitted).toEqual([])
	})

	test('a submitted run is accepted with its id, and its task is carried', () => {
		const service = createFakeService()
		const response = handleApi(post('/api/runs', { task: 'add a flag', autonomy: 'supervised' }), routes(service))
		expect(response.status).toBe(202)
		expect(response.body).toEqual({ runId: 'run-1' })
		expect(service.submitted).toEqual([{ task: 'add a flag', autonomy: 'supervised' }])
	})

	test('an unrecognised autonomy falls back to the server default', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x', autonomy: 'whatever' }), routes(service))
		expect(service.submitted[0]?.autonomy).toBe('auto')
	})

	test('a second run is refused while one is going', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'first' }), routes(service))
		const second = handleApi(post('/api/runs', { task: 'second' }), routes(service))
		expect(second.status).toBe(409)
		expect(service.submitted).toHaveLength(1)
	})

	test('the list summaries the runs', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'a task' }), routes(service))
		const body = handleApi(get('/api/runs'), routes(service)).body as { runs: readonly Record<string, unknown>[] }
		expect(body.runs).toHaveLength(1)
		expect(body.runs[0]?.['runId']).toBe('run-1')
		expect(body.runs[0]?.['agents']).toBe(1)
	})

	test('a run detail says whether it is still going', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'a task' }), routes(service))
		const detail = handleApi(get('/api/runs/run-1'), routes(service)).body as Record<string, unknown>
		expect(detail['running']).toBe(true)
		expect(detail['paused']).toBe(false)

		service.finish('run-1')
		const after = handleApi(get('/api/runs/run-1'), routes(service)).body as Record<string, unknown>
		expect(after['running']).toBe(false)
	})

	test('an unknown run is a 404', () => {
		expect(handleApi(get('/api/runs/ghost'), routes(createFakeService())).status).toBe(404)
	})

	test('events are paged by offset and limit', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))

		const all = handleApi(get('/api/runs/run-1/events'), routes(service)).body as {
			total: number
			events: readonly RunLogRecord[]
		}
		expect(all.total).toBe(2)
		expect(all.events.map((record) => record.type)).toEqual(['run_started', 'agent_start'])

		const page = handleApi(get('/api/runs/run-1/events', 'offset=1&limit=1'), routes(service)).body as {
			events: readonly RunLogRecord[]
		}
		expect(page.events).toHaveLength(1)
		expect(page.events[0]?.type).toBe('agent_start')
	})

	test('a diff refusal is a 409 carrying the reason', () => {
		const service = createFakeService({ diff: failed('no agent with a commit') })
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const response = handleApi(get('/api/runs/run-1/diff'), routes(service))
		expect(response.status).toBe(409)
		expect(response.body).toEqual({ error: 'no agent with a commit' })
	})

	test('merge needs an agent, and reports what it merged', () => {
		const service = createFakeService()
		expect(handleApi(post('/api/runs/run-1/merge', {}), routes(service)).status).toBe(400)
		expect(handleApi(post('/api/runs/run-1/merge', { agentId: 'ghost' }), routes(service)).status).toBe(409)
		expect(handleApi(post('/api/runs/run-1/merge', { agentId: 'a' }), routes(service)).body).toEqual({
			merged: 'mergesha',
		})
	})

	test('undo reports the commit the base went back to', () => {
		expect(handleApi(post('/api/runs/run-1/undo', {}), routes(createFakeService())).body).toEqual({
			baseSha: 'base0000',
		})
	})

	test('steering reaches the live control, and refuses a finished run', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))

		const steered = handleApi(post('/api/runs/run-1/steer', { message: 'use tabs' }), routes(service))
		expect(steered.status).toBe(202)

		service.finish('run-1')
		expect(handleApi(post('/api/runs/run-1/steer', { message: 'too late' }), routes(service)).status).toBe(409)
	})

	test('an empty steer is refused', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		expect(handleApi(post('/api/runs/run-1/steer', { message: '   ' }), routes(service)).status).toBe(400)
	})

	test('pause and resume flip the control the run is draining', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const control = service.controlFor('run-1')
		expect(control).toBeDefined()

		expect(handleApi(post('/api/runs/run-1/pause', {}), routes(service)).body).toEqual({ paused: true })
		expect(control?.paused).toBe(true)
		expect(handleApi(post('/api/runs/run-1/resume', {}), routes(service)).body).toEqual({ paused: false })
		expect(control?.paused).toBe(false)
	})

	test('a write method on a read route is refused rather than ignored', () => {
		expect(handleApi(post('/api/runs/run-1/events', {}), routes(createFakeService())).status).toBe(405)
	})
})

describe('the API routes and the trace', () => {
	test('the trace nests turns under their agent and prices them', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))

		// A finished agent, with a turn and a tool call on the record.
		const log: RunLogRecord[] = [
			{ index: 0, at: 't0', type: 'agent_start', event: { type: 'agent_start', agentId: 'a1', role: 'worker' } },
			{
				index: 1,
				at: 't1',
				type: 'model_call',
				event: {
					type: 'model_call',
					agentId: 'a1',
					model: 'test-model',
					usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
				},
			},
			{ index: 2, at: 't2', type: 'tool_result', event: { type: 'tool_result', agentId: 'a1', tool: 'read_file', kind: 'success' } },
			{ index: 3, at: 't3', type: 'agent_finish', event: { type: 'agent_finish', agentId: 'a1', status: 'success' } },
		]
		const withLog: RunService = { ...service, events: () => log }

		const body = handleApi(get('/api/runs/run-1/trace'), routes(withLog)).body as {
			spans: readonly { id: string; parentId: string | null; kind: string; costUsd: number }[]
		}

		const agent = body.spans.find((span) => span.kind === 'agent')
		const turn = body.spans.find((span) => span.kind === 'turn')
		const tool = body.spans.find((span) => span.kind === 'tool')

		expect(agent?.id).toBe('agent:a1')
		expect(turn?.parentId).toBe('agent:a1')
		expect(tool?.parentId).toBe('agent:a1')
		// 1M input tokens at $10 per 1M.
		expect(turn?.costUsd).toBeCloseTo(10, 10)
	})

	test('a subagent hangs off the agent that delegated to it', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const log: RunLogRecord[] = [
			{ index: 0, at: 't0', type: 'agent_start', event: { type: 'agent_start', agentId: 'parent', role: 'orchestrator', parentId: null } },
			{ index: 1, at: 't1', type: 'agent_start', event: { type: 'agent_start', agentId: 'child', role: 'worker', parentId: 'parent' } },
		]
		const body = handleApi(get('/api/runs/run-1/trace'), routes({ ...service, events: () => log })).body as {
			spans: readonly { id: string; parentId: string | null }[]
		}
		expect(body.spans.find((span) => span.id === 'agent:child')?.parentId).toBe('agent:parent')
	})

	test('a run with nothing recorded traces to nothing', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const body = handleApi(get('/api/runs/run-1/trace'), routes({ ...service, events: () => [] })).body as {
			spans: readonly unknown[]
		}
		expect(body.spans).toEqual([])
	})
})

describe('the trace of a run with an agent that never finished', () => {
	test('leaves the agent span open', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const log: RunLogRecord[] = [
			{
				index: 0,
				at: 't0',
				type: 'agent_start',
				event: { type: 'agent_start', agentId: 'a1', role: 'worker', parentId: null, depth: 0 },
			},
		]
		const body = handleApi(get('/api/runs/run-1/trace'), routes({ ...service, events: () => log })).body as {
			spans: readonly { finishedAt: string | null; attributes: Record<string, unknown> }[]
		}
		expect(body.spans[0]?.finishedAt).toBeNull()
		expect(body.spans[0]?.attributes['role']).toBe('worker')
	})

	test('an agent_finish without its start is ignored rather than invented', () => {
		const service = createFakeService()
		handleApi(post('/api/runs', { task: 'x' }), routes(service))
		const log: RunLogRecord[] = [
			{ index: 0, at: 't0', type: 'agent_finish', event: { type: 'agent_finish', agentId: 'ghost', status: 'success' } },
		]
		const body = handleApi(get('/api/runs/run-1/trace'), routes({ ...service, events: () => log })).body as {
			spans: readonly unknown[]
		}
		expect(body.spans).toEqual([])
	})
})

describe('a run manifest in the list', () => {
	test('carries the agent count the UI shows', () => {
		const service = createFakeService()
		const manifests = [{ ...createTestManifest({ agents: [createTestAgent(), createTestAgent({ agentId: 'b' })] }) }]
		const listable: RunService = { ...service, list: () => manifests }
		const body = handleApi(get('/api/runs'), routes(listable)).body as { runs: readonly { agents: number }[] }
		expect(body.runs[0]?.agents).toBe(2)
	})
})
