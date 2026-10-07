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

import { addUsage, ZERO_USAGE } from '../deployment/cost.ts'
import type { Usage } from '../model/types.ts'
import type { RunResult } from '../scheduler/types.ts'
import type { RunEvent, RunEventSink } from './events.ts'
import type { RunStore } from './store.ts'
import type { AgentRecord, AutonomyLevel, ModelUsage, RunManifest, RunStatus } from './types.ts'

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

interface RunTotals {
	readonly usage: Usage
	readonly costUsd: number
	readonly models: readonly ModelUsage[]
}

/** Rolls per-agent totals up to the run, and breaks them down by model. */
function summarize(agents: readonly AgentRecord[]): RunTotals {
	let usage: Usage = { ...ZERO_USAGE }
	let costUsd = 0
	const byModel = new Map<string, { usage: Usage; costUsd: number }>()

	for (const agent of agents) {
		usage = addUsage(usage, agent.usage)
		costUsd += agent.costUsd

		const existing = byModel.get(agent.model) ?? { usage: { ...ZERO_USAGE }, costUsd: 0 }
		byModel.set(agent.model, {
			usage: addUsage(existing.usage, agent.usage),
			costUsd: existing.costUsd + agent.costUsd,
		})
	}

	const models: ModelUsage[] = [...byModel].map(([model, totals]) => ({
		model,
		usage: totals.usage,
		costUsd: totals.costUsd,
	}))
	models.sort((left, right) => left.model.localeCompare(right.model))
	return { usage, costUsd, models }
}

export function createRunRecorder(dependencies: RunRecorderDependencies, options: RunRecorderOptions): RunRecorder {
	const startedAt = new Date(dependencies.now()).toISOString()
	/** Who spawned, in the order they were spawned. */
	const spawnOrder: string[] = []
	const spawned = new Set<string>()
	const records = new Map<string, AgentRecord>()

	function spawn(agentId: string): void {
		if (spawned.has(agentId)) return
		spawned.add(agentId)
		spawnOrder.push(agentId)
	}

	/**
	 * The manifest's agents, in **spawn order**.
	 *
	 * Ordering by finish is the obvious implementation and the wrong one: a child
	 * finishes before the parent that delegated to it, so the run would list its
	 * agents backwards. Spawn order is what a reader expects, and it is what the
	 * manifest promises.
	 */
	function orderedAgents(): readonly AgentRecord[] {
		const ordered: AgentRecord[] = []
		for (const agentId of spawnOrder) {
			const record = records.get(agentId)
			if (record !== undefined) ordered.push(record)
		}
		return ordered
	}

	function persist(status: RunStatus, finishedAt: string | null): RunManifest {
		const agents = orderedAgents()
		const totals = summarize(agents)
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
			usage: totals.usage,
			costUsd: totals.costUsd,
			models: totals.models,
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

			if (event.type === 'agent_start') {
				spawn(event.agentId)
				return
			}
			if (event.type !== 'agent_finish') return

			// A finish with no matching start still belongs in the manifest: a log
			// replayed from disk may not carry the spawn.
			spawn(event.agentId)
			records.set(event.agentId, {
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
				model: event.model,
				usage: event.usage,
				costUsd: event.costUsd,
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
