import type { WorktreeManager } from '../workspace/worktree.ts'

export interface FakeWorktrees extends WorktreeManager {
	/** Agent ids a worktree was created for, in order. */
	readonly created: readonly string[]
	/** `agentId@base` for every creation, so which commit a child branched from is visible. */
	readonly createdFrom: readonly string[]
	/** Agent ids that were committed, in order. */
	readonly committed: readonly string[]
	/** `branch -> into [policy]` for every integration, in order. */
	readonly integrated: readonly string[]
}

export interface FakeWorktreeOptions {
	readonly baseSha?: string
	/**
	 * What `headOf` reports for a workspace that is not the repository root.
	 *
	 * Defaults to `baseSha` — a caller that has not moved. Set it to model a caller
	 * that has: a child should follow it, and that is what the default hides. The
	 * root is always at `baseSha`, because that is where the run pinned it.
	 */
	readonly callerHead?: string
	/** The repository root, which is the workspace a root role runs in. */
	readonly repoPath?: string
	/** When false, `commit` reports that the agent changed nothing. */
	readonly dirty?: boolean
	/** When true, every integration reports a conflict. */
	readonly integrationConflict?: boolean
}

/**
 * An in-memory `WorktreeManager`, so scheduler tests exercise scheduling without
 * a repository. Real git behaviour is the integration lane's job.
 */
export function createFakeWorktrees(options: FakeWorktreeOptions = {}): FakeWorktrees {
	const baseSha = options.baseSha ?? 'base0000'
	const repoPath = options.repoPath ?? '/repo'
	const created: string[] = []
	const createdFrom: string[] = []
	const committed: string[] = []
	const integrated: string[] = []
	let commitCount = 0

	return {
		created,
		createdFrom,
		committed,
		integrated,
		resolveBaseSha: () => ({ kind: 'ok', value: baseSha }),
		headOf: (workspacePath) => ({
			kind: 'ok',
			value: workspacePath === repoPath ? baseSha : (options.callerHead ?? baseSha),
		}),
		create: (runId, agentId, from) => {
			createdFrom.push(`${agentId}@${from}`)
			return {
				kind: 'ok',
				value: {
					runId,
					agentId,
					branch: `loom/${runId}/${agentId}`,
					path: `/repo/.loom/worktrees/${runId}/${agentId}`,
					baseSha: from,
				},
			}
		},
		commit: (worktree) => {
			created.push(worktree.agentId)
			if (options.dirty === false) return { kind: 'ok', value: null }
			committed.push(worktree.agentId)
			commitCount += 1
			return { kind: 'ok', value: `sha${String(commitCount)}` }
		},
		integrate: (into, branch, integrateOptions) => {
			integrated.push(`${branch} -> ${into} [${integrateOptions.onConflict}]`)
			if (options.integrationConflict === true) return { kind: 'failed', message: 'merge conflict' }
			return { kind: 'ok', value: null }
		},
		remove: () => ({ kind: 'ok', value: null }),
		removeRun: () => ({ kind: 'ok', value: [] }),
		list: () => ({ kind: 'ok', value: [] }),
	}
}
