/**
 * The run service: what the HTTP layer can ask of a run.
 *
 * A run is single-flight per project — the workspace is one git repository, and
 * two runs sharing it would race on the same worktrees and the same index. The
 * service owns that invariant, so the transport does not have to.
 *
 * Starting a run does not wait for it: `submit` hands back the id while the run
 * proceeds in the background, because the whole point of the API is that the
 * operator can watch and steer a run that is still going.
 */

import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import type { AutonomyLevel } from '../runs/types.ts'
import type { RunLogRecord } from '../runs/validate.ts'
import type { RunManifest } from '../runs/types.ts'
import type { RunStore } from '../runs/store.ts'
import { createRunControl, type RunControl } from '../runs/control.ts'
import { diffRun, mergeAgent, undoRun, type RunLifecycle } from '../runs/lifecycle.ts'
import type { FetchLike } from '../model/openai.ts'
import type { RunTaskOptions } from '../run-task.ts'

export interface RunServiceDependencies {
	readonly store: RunStore
	readonly lifecycle: RunLifecycle
	readonly startRun: (options: RunTaskOptions) => Promise<unknown>
	readonly newRunId: () => string
	readonly repoPath: string
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly env: Readonly<Record<string, string | undefined>>
	readonly fetch: FetchLike
	/** A run that threw is a fact the operator needs; the service only reports it. */
	readonly reportFailure: (message: string) => void
}

export interface SubmitRequest {
	readonly task: string
	readonly autonomy: AutonomyLevel
}

export interface RunService {
	submit(request: SubmitRequest): OpResult<{ readonly runId: string }>
	/** The run currently going, if any. */
	active(): string | null
	/** The operator's channel into a run, or null when it is not the active one. */
	control(runId: string): RunControl | null
	list(): readonly RunManifest[]
	manifest(runId: string): RunManifest | null
	events(runId: string): readonly RunLogRecord[]
	/** The diff of a run's committed branches; all of them, or the agent named. */
	diff(runId: string, agentId: string | null): OpResult<string>
	merge(runId: string, agentId: string): OpResult<string>
	undo(runId: string): OpResult<string>
}

export function createRunService(dependencies: RunServiceDependencies): RunService {
	let active: { readonly runId: string; readonly control: RunControl } | null = null

	return {
		submit(request: SubmitRequest): OpResult<{ readonly runId: string }> {
			if (active !== null) {
				return failed(`a run is already in progress (${active.runId}); one run at a time per project`)
			}
			if (request.task.trim() === '') return failed('the task is empty')

			const runId = dependencies.newRunId()
			const control = createRunControl()
			active = { runId, control }

			const options: RunTaskOptions = {
				runId,
				control,
				repoPath: dependencies.repoPath,
				blueprintPath: dependencies.blueprintPath,
				deploymentPath: dependencies.deploymentPath,
				task: request.task,
				autonomy: request.autonomy,
				// A submitted run is unattended, so it gets no per-run extras.
				modelOverrides: {},
				approvals: [],
				env: dependencies.env,
				fetch: dependencies.fetch,
			}

			void dependencies
				.startRun(options)
				.catch((error: unknown) => {
					dependencies.reportFailure(error instanceof Error ? error.message : String(error))
				})
				.finally(() => {
					if (active?.runId === runId) active = null
				})

			return ok({ runId })
		},

		active(): string | null {
			return active?.runId ?? null
		},

		control(runId: string): RunControl | null {
			return active?.runId === runId ? active.control : null
		},

		list(): readonly RunManifest[] {
			const manifests: RunManifest[] = []
			for (const id of dependencies.store.listRunIds()) {
				const manifest = dependencies.store.readManifest(id)
				if (manifest !== null) manifests.push(manifest)
			}
			// Newest first: the run an operator wants is almost always the last one.
			return manifests.reverse()
		},

		manifest(runId: string): RunManifest | null {
			return dependencies.store.readManifest(runId)
		},

		events(runId: string): readonly RunLogRecord[] {
			return dependencies.store.readEvents(runId)
		},

		diff(runId: string, agentId: string | null): OpResult<string> {
			return diffRun(dependencies.store, dependencies.lifecycle, runId, agentId)
		},

		merge(runId: string, agentId: string): OpResult<string> {
			return mergeAgent(dependencies.store, dependencies.lifecycle, runId, agentId)
		},

		undo(runId: string): OpResult<string> {
			return undoRun(dependencies.store, dependencies.lifecycle, runId)
		},
	}
}
