/**
 * Where an agent's work lives.
 *
 * Both the branch and the directory are derived from the run and agent ids
 * alone, so any process can find an agent's worktree without shared state — a
 * restart, a cleanup command, and the scheduler all agree by construction.
 */

import * as path from 'node:path'

/** The directory Loom keeps its bookkeeping in, inside the repository. */
export const LOOM_DIR = '.loom'

/** The entry added to the repository's git exclude file. */
export const EXCLUDE_ENTRY = `${LOOM_DIR}/`

export interface AgentLocation {
	readonly branch: string
	readonly worktreePath: string
}

/** The directory holding every worktree of one run. */
export function runWorktreeDirectory(repoPath: string, runId: string): string {
	return path.join(repoPath, LOOM_DIR, 'worktrees', runId)
}

/** The branch and directory for one agent of one run. */
export function agentLocation(repoPath: string, runId: string, agentId: string): AgentLocation {
	return {
		branch: `loom/${runId}/${agentId}`,
		worktreePath: path.join(runWorktreeDirectory(repoPath, runId), agentId),
	}
}
