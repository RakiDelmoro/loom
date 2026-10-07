import { describe, expect, test } from 'bun:test'
import type { RunResult } from '../scheduler/types.ts'
import { createCounterClock } from '../test-support/clock.ts'
import type { RunEvent } from './events.ts'
import { createRunRecorder } from './recorder.ts'
import type { RunStore } from './store.ts'
import type { RunManifest } from './types.ts'

interface FakeStore extends RunStore {
	readonly manifests: RunManifest[]
	readonly events: RunEvent[]
}

function createFakeStore(): FakeStore {
	const manifests: RunManifest[] = []
	const events: RunEvent[] = []
	return {
		manifests,
		events,
		runDirectory: (runId) => `/repo/.loom/runs/${runId}`,
		writeManifest: (_runId, manifest) => {
			manifests.push(manifest)
		},
		readManifest: () => manifests.at(-1) ?? null,
		appendEvent: (_runId, event) => {
			events.push(event)
		},
		listRunIds: () => [],
		readEvents: () => [],
	}
}

const finishEvent: RunEvent = {
	type: 'agent_finish',
	agentId: 'worker-1-2',
	role: 'worker',
	parentId: 'orchestrator-0-1',
	depth: 1,
	status: 'success',
	summary: 'wrote a file',
	branch: 'loom/run-1/worker-1-2',
	sha: 'def456',
	startedAt: '2026-10-07T14:22:35.000Z',
	finishedAt: '2026-10-07T14:26:10.000Z',
	model: 'test-model',
	usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
	costUsd: 0.5,
}

function createRecorder() {
	const store = createFakeStore()
	const recorder = createRunRecorder(
		{ store, now: createCounterClock(1_700_000_000_000) },
		{ runId: 'run-1', task: 'do it', baseRef: 'HEAD', baseSha: 'abc123', autonomy: 'auto' },
	)
	return { store, recorder }
}

const result: RunResult = {
	runId: 'run-1',
	baseSha: 'abc123',
	card: { status: 'success', summary: 'all done' },
	agents: [],
}

describe('createRunRecorder', () => {
	test('begin writes a running manifest and logs the start', () => {
		const { store, recorder } = createRecorder()
		const manifest = recorder.begin()

		expect(manifest.status).toBe('running')
		expect(manifest.finishedAt).toBeNull()
		expect(manifest.agents).toEqual([])
		expect(store.manifests).toHaveLength(1)
		expect(store.events.map((event) => event.type)).toEqual(['run_started'])
	})

	test('an agent finishing is folded into the manifest and logged', () => {
		const { store, recorder } = createRecorder()
		recorder.begin()
		recorder.events(finishEvent)

		expect(store.manifests).toHaveLength(2)
		const latest = store.manifests[1]
		expect(latest?.agents).toEqual([
			{
				agentId: 'worker-1-2',
				role: 'worker',
				parentId: 'orchestrator-0-1',
				depth: 1,
				status: 'success',
				summary: 'wrote a file',
				branch: 'loom/run-1/worker-1-2',
				sha: 'def456',
				startedAt: '2026-10-07T14:22:35.000Z',
				finishedAt: '2026-10-07T14:26:10.000Z',
				model: 'test-model',
				usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
				costUsd: 0.5,
			},
		])
		// The manifest stays `running` until the run itself finishes.
		expect(latest?.status).toBe('running')
	})

	test('agents are listed in spawn order, not finish order', () => {
		const { recorder } = createRecorder()
		recorder.begin()

		// The parent spawns the child, and the child finishes first — which is the
		// normal shape of a delegation, and the reason ordering by finish is wrong.
		recorder.events({
			type: 'agent_start',
			agentId: 'orchestrator-0-1',
			role: 'orchestrator',
			parentId: null,
			depth: 0,
		})
		recorder.events({ type: 'agent_start', agentId: 'worker-1-2', role: 'worker', parentId: 'orchestrator-0-1', depth: 1 })
		recorder.events(finishEvent)
		recorder.events({ ...finishEvent, agentId: 'orchestrator-0-1', role: 'orchestrator', parentId: null, depth: 0 })

		const manifest = recorder.finish(result)
		expect(manifest.agents.map((agent) => agent.agentId)).toEqual(['orchestrator-0-1', 'worker-1-2'])
	})

	test('a finish with no matching start still records the agent', () => {
		const { recorder } = createRecorder()
		recorder.begin()
		// A log replayed from disk may not carry the start; the agent must not vanish.
		recorder.events(finishEvent)
		expect(recorder.finish(result).agents.map((agent) => agent.agentId)).toEqual(['worker-1-2'])
	})

	test('an agent that starts but never finishes is not invented into the manifest', () => {
		const { recorder } = createRecorder()
		recorder.begin()
		recorder.events({ type: 'agent_start', agentId: 'slow-0-1', role: 'worker', parentId: null, depth: 0 })

		expect(recorder.finish(result).agents).toEqual([])
	})

	test('an agent finishing twice does not appear twice', () => {
		const { recorder } = createRecorder()
		recorder.begin()
		recorder.events(finishEvent)
		recorder.events({ ...finishEvent, status: 'error', summary: 'then failed' })

		const manifest = recorder.finish(result)
		expect(manifest.agents).toHaveLength(1)
		expect(manifest.agents[0]?.status).toBe('error')
	})

	test('the run total is the sum of its agents, broken down by model', () => {
		const { recorder } = createRecorder()
		recorder.begin()
		recorder.events(finishEvent)
		recorder.events({
			...finishEvent,
			agentId: 'worker-1-3',
			model: 'other-model',
			usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 1 },
			costUsd: 0.25,
		})

		const manifest = recorder.finish(result)
		expect(manifest.usage).toEqual({ inputTokens: 15, cachedInputTokens: 5, outputTokens: 3 })
		expect(manifest.costUsd).toBeCloseTo(0.75, 10)
		expect(manifest.models).toEqual([
			{ model: 'other-model', usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 1 }, costUsd: 0.25 },
			{ model: 'test-model', usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, costUsd: 0.5 },
		])
	})

	test('events other than an agent finishing are logged but do not change the manifest', () => {
		const { store, recorder } = createRecorder()
		recorder.begin()
		recorder.events({ type: 'tool_call', agentId: 'worker-1-2', tool: 'write_file', arguments: '{}' })

		expect(store.manifests).toHaveLength(1)
		expect(store.events).toHaveLength(2)
	})

	test('finish records the terminal status and the finish time', () => {
		const { store, recorder } = createRecorder()
		recorder.begin()
		const manifest = recorder.finish(result)

		expect(manifest.status).toBe('success')
		expect(manifest.finishedAt).not.toBeNull()
		expect(store.events.at(-1)).toEqual({ type: 'run_finished', status: 'success', summary: 'all done' })
	})

	test('abandon marks a run interrupted', () => {
		const { store, recorder } = createRecorder()
		recorder.begin()
		const manifest = recorder.abandon('the process was killed')

		expect(manifest.status).toBe('interrupted')
		expect(manifest.finishedAt).not.toBeNull()
		expect(store.events.at(-1)).toEqual({
			type: 'error',
			agentId: 'run',
			kind: 'interrupted',
			message: 'the process was killed',
		})
	})
})
