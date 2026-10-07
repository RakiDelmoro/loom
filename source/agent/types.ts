/**
 * What an agent produces.
 *
 * A `ResultCard` is the whole answer a role gives back to its caller — and, for
 * the entry role, the whole answer a run gives back to the operator. Everything
 * the engine does above a role is coordination of these cards.
 */

import type { Usage } from '../model/types.ts'

export type ResultStatus = 'success' | 'error' | 'needs_clarification'

export function isResultStatus(value: unknown): value is ResultStatus {
	return value === 'success' || value === 'error' || value === 'needs_clarification'
}

export interface ResultError {
	readonly kind: string
	readonly message: string
}

export interface ResultCard {
	readonly status: ResultStatus
	/** A short, plain-language explanation of the result. */
	readonly summary: string
	readonly artifacts?: readonly string[]
	readonly error?: ResultError
}

export interface AgentOutcome {
	readonly card: ResultCard
	readonly turns: number
	readonly usage: Usage
	readonly startedAt: number
	readonly finishedAt: number
}
