/**
 * Parsing a manifest back off disk.
 *
 * The manifest is written by Loom, but a file on disk is still external input: a
 * truncated write, a hand-edit, or a version skew must produce `null` rather
 * than a half-typed object the CLI then trusts and acts on.
 */

import { isResultStatus } from '../agent/types.ts'
import { isRecord } from '../guards.ts'
import type { Usage } from '../model/types.ts'
import type { AgentRecord, AutonomyLevel, RunManifest, RunStatus } from './types.ts'

function isRunStatus(value: unknown): value is RunStatus {
	return (
		value === 'running' ||
		value === 'success' ||
		value === 'error' ||
		value === 'needs_clarification' ||
		value === 'interrupted'
	)
}

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return value === 'auto' || value === 'supervised' || value === 'manual'
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value)) return false
	return (
		typeof value['inputTokens'] === 'number' &&
		typeof value['cachedInputTokens'] === 'number' &&
		typeof value['outputTokens'] === 'number'
	)
}

function parseAgentRecord(value: unknown): AgentRecord | null {
	if (!isRecord(value)) return null

	const agentId = value['agentId']
	const role = value['role']
	const parentId = value['parentId']
	const depth = value['depth']
	const status = value['status']
	const summary = value['summary']
	const branch = value['branch']
	const sha = value['sha']
	const startedAt = value['startedAt']
	const finishedAt = value['finishedAt']
	const usage = value['usage']

	if (typeof agentId !== 'string' || typeof role !== 'string') return null
	if (parentId !== null && typeof parentId !== 'string') return null
	if (typeof depth !== 'number' || !Number.isInteger(depth)) return null
	if (!isResultStatus(status)) return null
	if (typeof summary !== 'string') return null
	if (branch !== null && typeof branch !== 'string') return null
	if (sha !== null && typeof sha !== 'string') return null
	if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return null
	if (!isUsage(usage)) return null

	return { agentId, role, parentId, depth, status, summary, branch, sha, startedAt, finishedAt, usage }
}

export function parseRunManifest(value: unknown): RunManifest | null {
	if (!isRecord(value)) return null

	const runId = value['runId']
	const status = value['status']
	const task = value['task']
	const baseRef = value['baseRef']
	const baseSha = value['baseSha']
	const autonomy = value['autonomy']
	const startedAt = value['startedAt']
	const finishedAt = value['finishedAt']
	const agents = value['agents']
	const usage = value['usage']

	if (typeof runId !== 'string' || typeof task !== 'string') return null
	if (!isRunStatus(status)) return null
	if (typeof baseRef !== 'string' || typeof baseSha !== 'string') return null
	if (!isAutonomyLevel(autonomy)) return null
	if (typeof startedAt !== 'string') return null
	if (finishedAt !== null && typeof finishedAt !== 'string') return null
	if (!Array.isArray(agents)) return null
	if (!isUsage(usage)) return null

	const records: AgentRecord[] = []
	for (const agent of agents) {
		const record = parseAgentRecord(agent)
		if (record === null) return null
		records.push(record)
	}

	return { runId, status, task, baseRef, baseSha, autonomy, startedAt, finishedAt, agents: records, usage }
}
