import type { WorktreeManager } from '../workspace/worktree.ts'

export interface FakeWorktrees extends WorktreeManager {
	/** Agent ids a worktree was created for, in order. */
	readonly created: readonly string[]
	/** Agent ids that were committed, in order. */
	readonly committed: readonly string[]
}

export interface FakeWorktreeOptions {
	readonly baseSha?: string
	/** When false, `commit` reports that the agent changed nothing. */
	readonly dirty?: boolean
}

/**
 * An in-memory `WorktreeManager`, so scheduler tests exercise scheduling without
 * a repository. Real git behaviour is the integration lane's job.
 */
export function createFakeWorktrees(options: FakeWorktreeOptions = {}): FakeWorktrees {
	const baseSha = options.baseSha ?? 'base0000'
	const created: string[] = []
	const committed: string[] = []
	let commitCount = 0

	return {
		created,
		committed,
		resolveBaseSha: () => ({ kind: 'ok', value: baseSha }),
		create: (runId, agentId) => ({
			kind: 'ok',
			value: {
				runId,
				agentId,
				branch: `loom/${runId}/${agentId}`,
				path: `/repo/.loom/worktrees/${runId}/${agentId}`,
				baseSha,
			},
		}),
		commit: (worktree) => {
			created.push(worktree.agentId)
			if (options.dirty === false) return { kind: 'ok', value: null }
			committed.push(worktree.agentId)
			commitCount += 1
			return { kind: 'ok', value: `sha${String(commitCount)}` }
		},
		remove: () => ({ kind: 'ok', value: null }),
		removeRun: () => ({ kind: 'ok', value: [] }),
		list: () => ({ kind: 'ok', value: [] }),
	}
}
