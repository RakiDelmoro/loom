import { describe, expect, test } from 'bun:test'
import type { RunManifest } from './types.ts'
import { parseRunManifest } from './validate.ts'

const valid: RunManifest = {
	runId: 'run-1',
	status: 'success',
	task: 'write two files',
	baseRef: 'HEAD',
	baseSha: 'abc123',
	autonomy: 'auto',
	startedAt: '2026-10-07T14:22:33.000Z',
	finishedAt: '2026-10-07T14:31:02.000Z',
	agents: [
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
			usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
		},
	],
	usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
}

describe('parseRunManifest', () => {
	test('accepts a well-formed manifest', () => {
		expect(parseRunManifest(valid)).toEqual(valid)
	})

	test('accepts a run that has not finished', () => {
		expect(parseRunManifest({ ...valid, status: 'running', finishedAt: null })?.status).toBe('running')
	})

	test('accepts an agent that produced no commit', () => {
		const manifest = { ...valid, agents: [{ ...valid.agents[0], branch: null, sha: null }] }
		expect(parseRunManifest(manifest)?.agents[0]?.sha).toBeNull()
	})

	test('rejects a value that is not an object', () => {
		expect(parseRunManifest('nope')).toBeNull()
		expect(parseRunManifest(null)).toBeNull()
	})

	test('rejects an unknown status', () => {
		expect(parseRunManifest({ ...valid, status: 'finished' })).toBeNull()
	})

	test('rejects an unknown autonomy level', () => {
		expect(parseRunManifest({ ...valid, autonomy: 'yolo' })).toBeNull()
	})

	test('rejects a missing field', () => {
		const { baseSha: _dropped, ...broken } = valid
		expect(parseRunManifest(broken)).toBeNull()
	})

	test('rejects an agent record with a malformed usage block', () => {
		const manifest = { ...valid, agents: [{ ...valid.agents[0], usage: { inputTokens: 'many' } }] }
		expect(parseRunManifest(manifest)).toBeNull()
	})

	test('rejects a non-array agents field', () => {
		expect(parseRunManifest({ ...valid, agents: 'none' })).toBeNull()
	})
})
