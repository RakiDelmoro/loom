import { describe, expect, test } from 'bun:test'
import { createFakeGit, ok } from '../test-support/fake-git.ts'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import type { GitResult } from '../workspace/git.ts'
import { createWorktreeManager } from '../workspace/worktree.ts'
import { createCounterClock } from '../test-support/clock.ts'
import { noRedaction } from '../redact.ts'
import { createRunLifecycle, reconcileInterruptedRuns } from './lifecycle.ts'
import { createRunStore } from './store.ts'
import type { RunManifest } from './types.ts'

function createLifecycle(respond: (args: readonly string[]) => GitResult | undefined) {
	const git = createFakeGit(respond)
	const memory = createMemoryFileSystem({}, ['/repo', '/repo/.git'])
	const worktrees = createWorktreeManager({ git: git.runner, fs: memory.fs }, { repoPath: '/repo' })
	return { lifecycle: createRunLifecycle({ git: git.runner, worktrees }, { repoPath: '/repo' }), git }
}

describe('mergeBranch', () => {
	test('merges a branch and reports the new head', () => {
		const { lifecycle, git } = createLifecycle((args) => {
			if (args.includes('status')) return ok('')
			if (args.includes('merge')) return ok('Merge made by the ort strategy.\n')
			if (args.includes('rev-parse')) return ok('newhead\n')
			return undefined
		})

		expect(lifecycle.mergeBranch('loom/run-1/worker-1-2')).toEqual({ kind: 'ok', value: 'newhead' })
		expect(git.commands.at(-1)).toEqual(['-C', '/repo', 'rev-parse', 'HEAD'])
	})

	test('refuses to merge into a tree with uncommitted work, and never runs the merge', () => {
		const { lifecycle, git } = createLifecycle((args) => (args.includes('status') ? ok(' M src/a.ts\n') : undefined))

		const result = lifecycle.mergeBranch('loom/run-1/worker-1-2')
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('uncommitted changes')
		expect(git.commands).toHaveLength(1)
	})

	test('reports a merge that git itself refuses', () => {
		const { lifecycle } = createLifecycle((args) => {
			if (args.includes('status')) return ok('')
			if (args.includes('merge')) return { kind: 'failed', message: 'CONFLICT (content): Merge conflict in a.ts' }
			return undefined
		})

		const result = lifecycle.mergeBranch('loom/run-1/worker-1-2')
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('CONFLICT')
	})
})

describe('undo', () => {
	test('resets the base branch to the commit the run started from', () => {
		const { lifecycle, git } = createLifecycle((args) => {
			if (args.includes('status')) return ok('')
			if (args.includes('reset')) return ok('')
			return undefined
		})

		expect(lifecycle.undo('abc123')).toEqual({ kind: 'ok', value: null })
		expect(git.commands.at(-1)).toEqual(['-C', '/repo', 'reset', '--hard', 'abc123'])
	})

	test('refuses to reset a tree with uncommitted work, and never runs the reset', () => {
		const { lifecycle, git } = createLifecycle((args) => (args.includes('status') ? ok('?? notes.md\n') : undefined))

		expect(lifecycle.undo('abc123').kind).toBe('failed')
		expect(git.commands).toHaveLength(1)
	})
})

describe('diffBetween', () => {
	test('returns the diff between a base commit and a branch', () => {
		const { lifecycle, git } = createLifecycle((args) => (args.includes('diff') ? ok('diff --git a/x b/x\n') : undefined))

		expect(lifecycle.diffBetween('base', 'branch')).toEqual({ kind: 'ok', value: 'diff --git a/x b/x\n' })
		expect(git.commands.at(-1)).toEqual(['-C', '/repo', 'diff', 'base', 'branch'])
	})

	test('reports a git failure', () => {
		const { lifecycle } = createLifecycle((args) => (args.includes('diff') ? { kind: 'failed', message: 'bad revision' } : undefined))
		expect(lifecycle.diffBetween('base', 'branch').kind).toBe('failed')
	})
})

describe('clean', () => {
	test('removes the run\u2019s worktrees', () => {
		const { lifecycle } = createLifecycle((args) => (args[0] === 'worktree' ? ok('') : undefined))
		expect(lifecycle.clean('run-1', { branches: true })).toEqual({ kind: 'ok', value: [] })
	})
})

describe('reconcileInterruptedRuns', () => {
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
		costUsd: 0,
		models: [],
	}

	function createStore() {
		const memory = createMemoryFileSystem({}, ['/repo'])
		return createRunStore(
			{ fs: memory.fs, now: createCounterClock(1_700_000_000_000), redact: noRedaction },
			{ repoPath: '/repo' },
		)
	}

	test('a run left running by a process that exited is marked interrupted', () => {
		// Nothing can be in flight when a reader starts, so `running` can only mean
		// the process that owned the run is gone. Left alone the UI reports a run
		// that is happening beside a log that stopped hours ago — which is what an
		// operator saw, and had no way to tell from a slow run.
		const store = createStore()
		store.writeManifest('run-1', manifest)

		expect(reconcileInterruptedRuns(store, () => 1_700_000_000_000)).toEqual(['run-1'])

		const after = store.readManifest('run-1')
		expect(after?.status).toBe('interrupted')
		expect(after?.finishedAt).toBe('2023-11-14T22:13:20.000Z')

		// The reason goes in the log, exactly as it does for a run that was killed:
		// the two doors into "this run is over" should read the same afterwards.
		const last = store.readEvents('run-1').at(-1)
		expect(last?.type).toBe('error')
	})

	test('a run that already finished is left alone', () => {
		const store = createStore()
		store.writeManifest('run-1', { ...manifest, status: 'success', finishedAt: '2026-10-07T14:30:00.000Z' })

		expect(reconcileInterruptedRuns(store, () => 1_700_000_000_000)).toEqual([])
		expect(store.readManifest('run-1')?.status).toBe('success')
		expect(store.readEvents('run-1')).toHaveLength(0)
	})
})
