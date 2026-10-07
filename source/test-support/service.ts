/**
 * A run service a test can drive without a repository, a model, or a socket.
 *
 * Shared because two test files need the same one: the routing tests call the
 * handlers directly, and the transport tests put the same service behind a real
 * HTTP server. One double, so a change to the service interface breaks in one
 * place rather than two.
 */

import { createRunControl, type RunControl } from '../runs/control.ts'
import type { RunManifest } from '../runs/types.ts'
import type { RunLogRecord } from '../runs/validate.ts'
import { failed, ok, type OpResult } from '../result.ts'
import { createTestManifest } from './runs.ts'
import type { RunService, SubmitRequest } from '../server/service.ts'

export interface FakeRunService extends RunService {
	readonly submitted: SubmitRequest[]
	readonly controlFor: (runId: string) => RunControl | undefined
	/** Ends a run: it stops being active, so its control is released. */
	finish(runId: string): void
}

export function createFakeRunService(options: { readonly diff?: OpResult<string> } = {}): FakeRunService {
	const manifests = new Map<string, RunManifest>()
	const logs = new Map<string, readonly RunLogRecord[]>()
	const controls = new Map<string, RunControl>()
	const submitted: SubmitRequest[] = []
	let activeRunId: string | null = null
	let counter = 0

	return {
		submitted,
		controlFor: (runId) => controls.get(runId),

		finish(runId) {
			controls.delete(runId)
			if (activeRunId === runId) activeRunId = null
		},

		submit(request) {
			if (activeRunId !== null) return failed('a run is already in progress')
			counter += 1
			const runId = `run-${String(counter)}`
			submitted.push(request)
			activeRunId = runId
			controls.set(runId, createRunControl())
			manifests.set(runId, createTestManifest({ runId, task: request.task, status: 'running', finishedAt: null }))
			logs.set(runId, [
				{ index: 0, at: '2026-01-01T00:00:00.000Z', type: 'run_started', event: { type: 'run_started', runId } },
				{ index: 1, at: '2026-01-01T00:00:01.000Z', type: 'agent_start', event: { type: 'agent_start', agentId: 'a' } },
			])
			return ok({ runId })
		},

		active: () => activeRunId,
		control: (runId) => (activeRunId === runId ? controls.get(runId) ?? null : null),
		list: () => [...manifests.values()],
		manifest: (runId) => manifests.get(runId) ?? null,
		events: (runId) => logs.get(runId) ?? [],
		diff: () => options.diff ?? ok('--- a\n+++ b\n'),
		merge: (_runId, agentId) => (agentId === 'ghost' ? failed('no agent "ghost"') : ok('mergesha')),
		undo: () => ok('base0000'),
		stop: () => {},
	}
}
