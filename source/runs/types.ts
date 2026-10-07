/**
 * The run manifest: the durable, machine-readable record of a run.
 *
 * Where the event log is the blow-by-blow, the manifest is the summary and the
 * contract — what ran, what it produced, where it started from. `loom undo`
 * depends on `baseSha`; `loom diff` and `loom merge` depend on the per-agent
 * branches and shas. If the manifest and the repository disagree, the manifest
 * is wrong.
 */

import type { ResultStatus } from '../agent/types.ts'
import type { Usage } from '../model/types.ts'

export type RunStatus = 'running' | ResultStatus | 'interrupted'

/**
 * Who decides what merges. `auto` is the default: the operator is not the gate,
 * the tests are, and `loom undo` is the safety net.
 */
export type AutonomyLevel = 'auto' | 'supervised' | 'manual'

export interface AgentRecord {
	readonly agentId: string
	readonly role: string
	readonly parentId: string | null
	readonly depth: number
	readonly status: ResultStatus
	readonly summary: string
	readonly branch: string | null
	readonly sha: string | null
	readonly startedAt: string
	readonly finishedAt: string
	readonly usage: Usage
}

export interface RunManifest {
	readonly runId: string
	readonly status: RunStatus
	readonly task: string
	/** The ref the run was pinned to, and the commit it resolved to. */
	readonly baseRef: string
	readonly baseSha: string
	readonly autonomy: AutonomyLevel
	readonly startedAt: string
	readonly finishedAt: string | null
	/** Every agent that ran, in spawn order. */
	readonly agents: readonly AgentRecord[]
	readonly usage: Usage
}

/** The branches an agent produced work on, in spawn order. */
export function agentBranches(manifest: RunManifest): string[] {
	const branches: string[] = []
	for (const agent of manifest.agents) {
		if (agent.sha !== null && agent.branch !== null) branches.push(agent.branch)
	}
	return branches
}
