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
			readonly type: 'agent_finish'
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
			readonly model: string
			readonly usage: Usage
			readonly costUsd: number
	  }
	| { readonly type: 'error'; readonly agentId: string; readonly kind: string; readonly message: string }
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
