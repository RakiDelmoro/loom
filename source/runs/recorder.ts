/**
 * The run recorder: turns the scheduler's event stream into a durable record.
 *
 * It is the only thing that writes the manifest and the log, so the rules for
 * both live in one place:
 *
 *   - every event is appended to the log as it happens;
 *   - the manifest is rewritten whenever an agent finishes, so a run that is
 *     killed mid-flight still leaves a manifest naming every agent that ran —
 *     which is exactly what `loom clean` needs to tidy up after it.
 */

import type { RunResult } from '../scheduler/types.ts'
import type { RunEvent, RunEventSink } from './events.ts'
import type { RunStore } from './store.ts'
import type { AgentRecord, AutonomyLevel, RunManifest, RunStatus } from './types.ts'

const ZERO_USAGE = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }

export interface RunRecorderDependencies {
	readonly store: RunStore
	readonly now: () => number
}

export interface RunRecorderOptions {
	readonly runId: string
	readonly task: string
	readonly baseRef: string
	readonly baseSha: string
	readonly autonomy: AutonomyLevel
}

export interface RunRecorder {
	/** Hand this to the scheduler; every event is logged and folded into the manifest. */
	readonly events: RunEventSink
	begin(): RunManifest
	finish(result: RunResult): RunManifest
	abandon(message: string): RunManifest
}

export function createRunRecorder(dependencies: RunRecorderDependencies, options: RunRecorderOptions): RunRecorder {
	const startedAt = new Date(dependencies.now()).toISOString()
	const agents: AgentRecord[] = []

	function persist(status: RunStatus, finishedAt: string | null): RunManifest {
		const manifest: RunManifest = {
			runId: options.runId,
			status,
			task: options.task,
			baseRef: options.baseRef,
			baseSha: options.baseSha,
			autonomy: options.autonomy,
			startedAt,
			finishedAt,
			agents: [...agents],
			usage: agents.reduce(
				(total, agent) => ({
					inputTokens: total.inputTokens + agent.usage.inputTokens,
					cachedInputTokens: total.cachedInputTokens + agent.usage.cachedInputTokens,
					outputTokens: total.outputTokens + agent.usage.outputTokens,
				}),
				{ ...ZERO_USAGE },
			),
		}
		dependencies.store.writeManifest(options.runId, manifest)
		return manifest
	}

	function timestamp(): string {
		return new Date(dependencies.now()).toISOString()
	}

	return {
		events(event: RunEvent): void {
			dependencies.store.appendEvent(options.runId, event)
			if (event.type !== 'agent_finish') return

			agents.push({
				agentId: event.agentId,
				role: event.role,
				parentId: event.parentId,
				depth: event.depth,
				status: event.status,
				summary: event.summary,
				branch: event.branch,
				sha: event.sha,
				startedAt: event.startedAt,
				finishedAt: event.finishedAt,
				usage: event.usage,
			})
			persist('running', null)
		},

		begin(): RunManifest {
			dependencies.store.appendEvent(options.runId, {
				type: 'run_started',
				runId: options.runId,
				task: options.task,
				baseSha: options.baseSha,
			})
			return persist('running', null)
		},

		finish(result: RunResult): RunManifest {
			dependencies.store.appendEvent(options.runId, {
				type: 'run_finished',
				status: result.card.status,
				summary: result.card.summary,
			})
			return persist(result.card.status, timestamp())
		},

		abandon(message: string): RunManifest {
			dependencies.store.appendEvent(options.runId, { type: 'error', agentId: 'run', kind: 'interrupted', message })
			return persist('interrupted', timestamp())
		},
	}
}
