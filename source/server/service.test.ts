import { describe, expect, test } from 'bun:test'
import { ok } from '../result.ts'
import type { RunLifecycle } from '../runs/lifecycle.ts'
import type { RunStore } from '../runs/store.ts'
import type { RunManifest } from '../runs/types.ts'
import { createRunService } from './service.ts'

/**
 * Where a run's diff is read from.
 *
 * The diff is the work: not "the agent said it fixed it" but the lines that
 * changed. Reading it needs the run's *branch*, and a branch lives in the
 * repository the run happened in — which is not necessarily the one a viewer is
 * serving. A record that says where it ran is what makes the difference between
 * showing the work and reporting that it cannot be shown.
 */

const manifest: RunManifest = {
	runId: 'run-1',
	status: 'success',
	task: 'fix it',
	baseRef: 'HEAD',
	baseSha: 'base123',
	autonomy: 'auto',
	startedAt: '2026-01-01T00:00:00.000Z',
	finishedAt: '2026-01-01T00:01:00.000Z',
	agents: [
		{
			agentId: 'coder-1-2',
			role: 'coder',
			parentId: 'orchestrator-0-1',
			depth: 1,
			task: 'fix it',
			status: 'success',
			summary: 'done',
			branch: 'loom/run-1/coder-1-2',
			sha: 'sha2',
			startedAt: '2026-01-01T00:00:00.000Z',
			finishedAt: '2026-01-01T00:01:00.000Z',
			model: 'test-model',
			usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
			costUsd: 0,
		},
	],
	usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
	costUsd: 0,
	models: [],
}

function createService(owner: { readonly pid: number; readonly repoPath?: string } | null) {
	// Each lifecycle answers with the repository it was built for, so which one
	// ran the diff is visible in the output rather than inferred.
	const lifecycleFor = (name: string): RunLifecycle => ({
		diffBetween: (baseSha, branch) => ok(`${name} ${baseSha} ${branch}`),
		mergeBranch: () => ok(''),
		undo: () => ok(null),
		clean: () => ok([]),
	})

	const store = {
		readManifest: () => manifest,
		readOwner: () => owner,
	} as unknown as RunStore

	return createRunService({
		store,
		lifecycle: lifecycleFor('here'),
		lifecycleFor: () => lifecycleFor('there'),
		startRun: async () => undefined,
		newRunId: () => 'run-2',
		repoPath: '/repo',
		blueprintPath: '/bp.json',
		deploymentPath: '/dep.json',
		env: {},
		fetch: async () => new Response('{}'),
		reportFailure: () => undefined,
	})
}

describe('reading a run from the repository it ran in', () => {
	test('a run that names another repository is read there', () => {
		const service = createService({ pid: 4242, repoPath: '/elsewhere' })

		const diff = service.diff('run-1', 'coder-1-2')
		expect(diff.kind).toBe('ok')
		if (diff.kind === 'ok') expect(diff.value).toBe('there base123 loom/run-1/coder-1-2')
	})

	test('a run that happened here is read here', () => {
		const service = createService({ pid: 4242, repoPath: '/repo' })

		const diff = service.diff('run-1', 'coder-1-2')
		if (diff.kind === 'ok') expect(diff.value).toBe('here base123 loom/run-1/coder-1-2')
	})

	test('a record from before the field existed is read here', () => {
		// Every run written before this fell back to the serving repository, and
		// still does: the field is an addition, not a requirement.
		const service = createService({ pid: 4242 })

		const diff = service.diff('run-1', 'coder-1-2')
		if (diff.kind === 'ok') expect(diff.value).toBe('here base123 loom/run-1/coder-1-2')
	})
})
