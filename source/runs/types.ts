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
	/** What this role was asked to do. See `attemptKey`. */
	readonly task: string
	readonly status: ResultStatus
	readonly summary: string
	readonly branch: string | null
	readonly sha: string | null
	readonly startedAt: string
	readonly finishedAt: string
	/** The model that served this role, so a run is attributable, not just totalled. */
	readonly model: string
	readonly usage: Usage
	readonly costUsd: number
}

/** What one model contributed to a run. */
export interface ModelUsage {
	readonly model: string
	readonly usage: Usage
	readonly costUsd: number
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
	readonly costUsd: number
	/** The same totals, broken down by model. */
	readonly models: readonly ModelUsage[]
}

/** The branches an agent produced work on, in spawn order. */
/**
 * One request: a role, a task, and the agent that made the request.
 *
 * Two agents with the same key are the *same request made again* — a retry, not
 * two pieces of work. Two agents with the same role but different tasks are
 * genuinely different work, and both count.
 */
export function attemptKey(agent: {
	readonly parentId: string | null
	readonly role: string
	readonly task: string
}): string {
	return `${agent.parentId ?? 'root'}\u0000${agent.role}\u0000${agent.task}`
}

/**
 * The branches a run's work actually consists of.
 *
 * Two filters, both of which were missing and both of which cost real benchmarks:
 *
 * 1. **Only a successful role's work counts.** Failed attempts were being merged,
 *    so three coders that hit their turn limit had their commits land anyway.
 * 2. **A retry supersedes the attempt it replaces.** Merging every attempt stacked
 *    competing edits of the same files against the same base, which conflicts
 *    arithmetically — the more persistent the loop, the less able the run was to
 *    deliver, which inverts what retrying is for.
 */
export function acceptedBranches(manifest: RunManifest): string[] {
	const lastAttempt = new Map<string, number>()
	for (const [index, agent] of manifest.agents.entries()) {
		if (agent.status !== 'success') continue
		if (agent.sha === null || agent.branch === null) continue
		lastAttempt.set(attemptKey(agent), index)
	}

	const keep = new Set(lastAttempt.values())
	const branches: string[] = []
	for (const [index, agent] of manifest.agents.entries()) {
		if (!keep.has(index)) continue
		if (agent.branch !== null) branches.push(agent.branch)
	}
	return branches
}
