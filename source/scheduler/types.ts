/**
 * What a run produces, and what it reports while producing it.
 */

import type { ResultCard } from '../agent/types.ts'

export type RunEventType =
	| 'agent_start'
	| 'agent_finish'
	| 'commit'
	| 'depth_exceeded'
	| 'role_not_found'
	| 'worktree_failed'

export interface RunEvent {
	readonly type: RunEventType
	readonly agentId: string
	readonly role: string
	readonly parentId: string | null
	readonly detail?: string
}

/** One agent's participation in a run. */
export interface AgentNode {
	readonly agentId: string
	readonly role: string
	readonly parentId: string | null
	readonly depth: number
	readonly startedAt: number
	readonly finishedAt: number
	readonly card: ResultCard
	/** The branch the agent committed to, when it had its own worktree. */
	readonly branch: string | null
	/** The commit the agent produced, or null when it changed nothing. */
	readonly sha: string | null
}

export interface RunResult {
	readonly runId: string
	readonly baseSha: string
	/** The entry role's card — the run's answer. */
	readonly card: ResultCard
	/** Every agent that ran, in the order it started. */
	readonly agents: readonly AgentNode[]
}
