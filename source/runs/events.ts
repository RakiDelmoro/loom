/**
 * The run event vocabulary.
 *
 * This is the append-only record of what a run did. It is the only thing the
 * engine writes incrementally, so it must be true even when the process dies
 * mid-run: nothing is ever rewritten, and every event is a complete statement on
 * its own line.
 */

import type { ResultStatus } from '../agent/types.ts'
import type { Usage } from '../model/types.ts'

export type RunEvent =
	| { readonly type: 'run_started'; readonly runId: string; readonly task: string; readonly baseSha: string }
	| {
			readonly type: 'agent_start'
			readonly agentId: string
			readonly role: string
			readonly parentId: string | null
			readonly depth: number
			/**
			 * What this role was asked to do.
			 *
			 * The run's record has always said which role ran and what it reported;
			 * it never said what it was asked. Without that, "the orchestrator asked
			 * for the same thing again" cannot be told from "the orchestrator asked
			 * two agents for different things" — which is the difference between a
			 * retry and parallel work, and the signal a progress check needs.
			 */
			readonly task: string
	  }
	| { readonly type: 'tool_call'; readonly agentId: string; readonly tool: string; readonly arguments: string }
	| {
			readonly type: 'tool_result'
			readonly agentId: string
			readonly tool: string
			readonly kind: string
			/**
			 * The un-truncated result, so a reviewer can see what the tool actually
			 * returned rather than only that it succeeded. Redacted before it is written.
			 */
			readonly result: unknown
	  }
	| { readonly type: 'commit'; readonly agentId: string; readonly branch: string; readonly sha: string | null }
	| {
			/** A child's committed branch merged into the workspace its caller works in. */
			readonly type: 'integration'
			readonly agentId: string
			readonly branch: string
			readonly into: string
			readonly status: 'merged' | 'conflict'
			readonly message: string
	  }
	| {
			readonly type: 'agent_finish'
			readonly agentId: string
			readonly role: string
			readonly parentId: string | null
			readonly depth: number
			/** The same task `agent_start` carried, so the record is built from one event. */
			readonly task: string
			readonly status: ResultStatus
			readonly summary: string
			readonly branch: string | null
			readonly sha: string | null
			readonly startedAt: string
			readonly finishedAt: string
			readonly model: string
			readonly usage: Usage
			readonly costUsd: number
	  }
	| {
			/**
			 * One completed model call. The per-turn record: `agent_finish` carries the
			 * agent's totals, but only this says which turn cost what, and how long it took.
			 */
			readonly type: 'model_call'
			readonly agentId: string
			readonly model: string
			readonly usage: Usage
			readonly messageCount: number
			readonly durationMs: number
	  }
	| { readonly type: 'error'; readonly agentId: string; readonly kind: string; readonly message: string }
	| {
			/** A message the operator injected into a running role's conversation. */
			readonly type: 'operator_notice'
			readonly agentId: string
			readonly message: string
	  }
	| {
			readonly type: 'alert'
			readonly kind: 'cost' | 'tokens'
			readonly threshold: number
			readonly actual: number
	  }
	| { readonly type: 'run_finished'; readonly status: ResultStatus; readonly summary: string }

export type RunEventSink = (event: RunEvent) => void

/** One line of `events.jsonl`: the event plus when it happened. */
export type RunLogLine = RunEvent & { readonly at: string }

export function logLine(event: RunEvent, at: string): RunLogLine {
	return { ...event, at }
}
