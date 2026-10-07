import { describe, expect, test } from 'bun:test'
import { createCounterClock } from '../test-support/clock.ts'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createRunStore } from './store.ts'
import type { RunManifest } from './types.ts'

const manifest: RunManifest = {
	runId: 'run-1',
	status: 'running',
	task: 'do it',
	baseRef: 'HEAD',
	baseSha: 'abc123',
	autonomy: 'auto',
	startedAt: '2026-10-07T14:22:33.000Z',
	finishedAt: null,
	agents: [],
	usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
}

function createStore() {
	const memory = createMemoryFileSystem({}, ['/repo'])
	return {
		memory,
		store: createRunStore({ fs: memory.fs, now: createCounterClock(1_700_000_000_000) }, { repoPath: '/repo' }),
	}
}

describe('createRunStore', () => {
	test('round-trips a manifest', () => {
		const { store } = createStore()
		store.writeManifest('run-1', manifest)
		expect(store.readManifest('run-1')).toEqual(manifest)
	})

	test('places a run under .loom/runs/<runId>', () => {
		const { store } = createStore()
		expect(store.runDirectory('run-1')).toBe('/repo/.loom/runs/run-1')
	})

	test('reports a missing run rather than throwing', () => {
		const { store } = createStore()
		expect(store.readManifest('ghost')).toBeNull()
	})

	test('reports a corrupt manifest rather than throwing', () => {
		const { store, memory } = createStore()
		memory.files.set('/repo/.loom/runs/run-1/run.json', '{ not json')
		expect(store.readManifest('run-1')).toBeNull()
	})

	test('reports a manifest that parses but is not a manifest', () => {
		const { store, memory } = createStore()
		memory.files.set('/repo/.loom/runs/run-1/run.json', '{"runId":"run-1"}')
		expect(store.readManifest('run-1')).toBeNull()
	})

	test('appends one line per event, without rewriting what is already there', () => {
		const { store, memory } = createStore()
		store.appendEvent('run-1', { type: 'run_started', runId: 'run-1', task: 'do it', baseSha: 'abc123' })
		store.appendEvent('run-1', { type: 'run_finished', status: 'success', summary: 'done' })

		const text = memory.files.get('/repo/.loom/runs/run-1/events.jsonl') ?? ''
		const lines = text.trim().split('\n')
		expect(lines).toHaveLength(2)

		const first = JSON.parse(lines[0] ?? '{}')
		expect(first.type).toBe('run_started')
		expect(typeof first.at).toBe('string')

		const second = JSON.parse(lines[1] ?? '{}')
		expect(second.type).toBe('run_finished')
	})

	test('lists run ids, sorted', () => {
		const { store } = createStore()
		store.writeManifest('run-b', { ...manifest, runId: 'run-b' })
		store.writeManifest('run-a', { ...manifest, runId: 'run-a' })
		expect(store.listRunIds()).toEqual(['run-a', 'run-b'])
	})

	test('lists no runs in a repository that has none', () => {
		expect(createStore().store.listRunIds()).toEqual([])
	})
})
