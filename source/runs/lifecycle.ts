/**
 * The operations that make a run reversible: inspect, merge, undo, clean.
 *
 * All four are git operations against the base repository, and all four refuse
 * to touch a tree with uncommitted work — an operator's unfinished edit is never
 * something Loom may discard to get its own job done.
 */

import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import type { GitRunner } from '../workspace/git.ts'
import type { WorktreeManager } from '../workspace/worktree.ts'

export interface RunLifecycleDependencies {
	readonly git: GitRunner
	readonly worktrees: WorktreeManager
}

export interface RunLifecycle {
	/** The diff an agent's branch introduced, against the commit the run started from. */
	diffBetween(baseSha: string, branch: string): OpResult<string>
	/** Applies one agent's branch to the base branch, as a merge commit. */
	mergeBranch(branch: string): OpResult<string>
	/** Returns the base branch to the commit the run started from. */
	undo(baseSha: string): OpResult<null>
	/** Removes a run's worktrees, and optionally its branches. */
	clean(runId: string, options: { readonly branches: boolean }): OpResult<readonly string[]>
}

export function createRunLifecycle(
	dependencies: RunLifecycleDependencies,
	options: { readonly repoPath: string },
): RunLifecycle {
	const { git, worktrees } = dependencies
	const { repoPath } = options

	/** Every destructive operation goes through this first. */
	function requireCleanBase(): OpResult<null> {
		const status = git.run(['-C', repoPath, 'status', '--porcelain'])
		if (status.kind !== 'ok') return failed(status.message)
		if (status.stdout.trim() !== '') {
			return failed('the base tree has uncommitted changes; commit or stash them first')
		}
		return ok(null)
	}

	return {
		diffBetween(baseSha: string, branch: string): OpResult<string> {
			const result = git.run(['-C', repoPath, 'diff', baseSha, branch])
			if (result.kind !== 'ok') return failed(result.message)
			return ok(result.stdout)
		},

		mergeBranch(branch: string): OpResult<string> {
			const clean = requireCleanBase()
			if (clean.kind !== 'ok') return failed(clean.message)

			const merged = git.run(['-C', repoPath, 'merge', '--no-ff', '--no-edit', '-m', `Loom: merge ${branch}`, branch])
			if (merged.kind !== 'ok') return failed(merged.message)

			const head = git.run(['-C', repoPath, 'rev-parse', 'HEAD'])
			if (head.kind !== 'ok') return failed(head.message)
			return ok(head.stdout.trim())
		},

		undo(baseSha: string): OpResult<null> {
			const clean = requireCleanBase()
			if (clean.kind !== 'ok') return failed(clean.message)

			const reset = git.run(['-C', repoPath, 'reset', '--hard', baseSha])
			if (reset.kind !== 'ok') return failed(reset.message)
			return ok(null)
		},

		clean(runId: string, cleanOptions: { readonly branches: boolean }): OpResult<readonly string[]> {
			return worktrees.removeRun(runId, cleanOptions)
		},
	}
}
