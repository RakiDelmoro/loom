/**
 * When the loop stops.
 *
 * A pure function of the state and the config, so termination is a thing to
 * reason about rather than an emergent property of a long-running process.
 *
 * A no-op hypothesis — wording that happens to move no score — is a *discard*,
 * counted against the plateau, not a termination reason. Stopping because one
 * idea failed would end every run at the first uninteresting hypothesis.
 */

import type { TunerConfig, TunerState } from './types.ts'

export interface Termination {
	readonly stop: boolean
	readonly reason: string | null
}

export function shouldTerminate(state: TunerState, config: TunerConfig): Termination {
	if (state.costUsd >= config.maxCostUsd) {
		return { stop: true, reason: `the Tuner's own spend reached $${state.costUsd.toFixed(4)} (ceiling $${config.maxCostUsd.toFixed(2)})` }
	}
	if (state.cycles >= config.maxCycles) {
		return { stop: true, reason: `the cycle budget of ${String(config.maxCycles)} is spent` }
	}
	if (state.plateau >= config.plateauLimit) {
		return { stop: true, reason: `${String(config.plateauLimit)} consecutive cycles improved nothing` }
	}
	return { stop: false, reason: null }
}

/** The state after one cycle that produced `improved` candidates (or none). */
export function advance(state: TunerState, outcome: { readonly improved: number; readonly costUsd: number }): TunerState {
	return {
		cycles: state.cycles + 1,
		costUsd: state.costUsd + outcome.costUsd,
		plateau: outcome.improved > 0 ? 0 : state.plateau + 1,
	}
}
