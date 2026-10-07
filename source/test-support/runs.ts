/**
 * Run fixtures for tests that need a manifest without running anything.
 *
 * A run manifest is wide and mostly incidental to a test's subject, so the
 * defaults here are a plausible finished run and a test overrides only the field
 * it cares about.
 */

import type { AgentRecord, ModelUsage, RunManifest } from '../runs/types.ts'

export function createTestAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		agentId: 'orchestrator-0-1',
		role: 'orchestrator',
		parentId: null,
		depth: 0,
		task: 'do the thing',
		status: 'success',
		summary: 'did the thing',
		branch: 'loom/orchestrator-0-1',
		sha: 'abc1234',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:02.000Z',
		model: 'test-model',
		usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
		costUsd: 0.0021,
		...overrides,
	}
}

export function createTestManifest(overrides: Partial<RunManifest> = {}): RunManifest {
	return {
		runId: 'run-1',
		status: 'success',
		task: 'do the thing',
		baseRef: 'HEAD',
		baseSha: 'base0000',
		autonomy: 'auto',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:02.000Z',
		agents: [createTestAgent()],
		usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
		costUsd: 0.0021,
		models: [] satisfies ModelUsage[],
		...overrides,
	}
}
