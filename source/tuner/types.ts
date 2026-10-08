/**
 * What the Tuner works with.
 *
 * A hypothesis is a concrete, testable change to the Blueprint. A change is the
 * **complete new contents** of a file, never a diff — that needs no patch engine,
 * and it makes every branch auditable by reading the file it produced.
 */

import type { Interval } from '../bench/score.ts'

export type Verdict = 'improved' | 'regressed' | 'noise'

/** A file to write, relative to the guild directory. */
export interface BlueprintChange {
	readonly path: string
	readonly content: string
}

export interface Hypothesis {
	readonly id: string
	readonly motivation: string
	readonly mechanism: string
	readonly predictedImpact: string
	readonly changes: readonly BlueprintChange[]
}

/** One hypothesis, taken all the way to a verdict. */
export interface BranchOutcome {
	readonly branchId: string
	readonly hypothesis: Hypothesis
	/** False when the edits produced a Blueprint the loader rejects. */
	readonly valid: boolean
	readonly invalidReason: string | null
	/** Safety invariants the candidate broke. A candidate with any is never evaluated. */
	readonly contractViolations: readonly string[]
	readonly optimizationScore: number
	readonly optimizationInterval: Interval
	readonly verdict: Verdict
	readonly verdictReasons: readonly string[]
	readonly costUsd: number
}

export interface TunerConfig {
	readonly suitePath: string
	/** The guild directory: the directory holding the baseline Blueprint. */
	readonly guildPath: string
	readonly deploymentPath: string
	/** Absent: the cycle budget does not bind, and the plateau is the only stop. */
	readonly maxCycles?: number
	/** The Tuner's own ceiling on optimization spend. Not the engine's. Absent: unbounded. */
	readonly maxCostUsd?: number
	readonly plateauLimit: number
	/** How far the candidate's score must beat the baseline, beyond the interval. */
	readonly improvementMargin: number
	/** How much cheaper a candidate must be to win on cost alone, in [0, 1). */
	readonly costMargin: number
	readonly repetitions: number
	readonly bigModel: { readonly provider: string; readonly model: string }
}

export interface TunerState {
	readonly cycles: number
	readonly costUsd: number
	readonly plateau: number
}

export interface HeldOutGate {
	readonly evaluated: boolean
	readonly baselineScore: number
	readonly candidateScore: number
	readonly verdict: Verdict
	readonly reason: string
}

export interface CycleReport {
	readonly cycle: number
	readonly baselineScore: number
	readonly baselineInterval: Interval
	readonly branches: readonly BranchOutcome[]
	readonly mergedChanges: readonly BlueprintChange[]
	readonly mergeNote: string | null
	readonly heldOut: HeldOutGate | null
	readonly promoted: boolean
	readonly costUsd: number
}

export interface TunerReport {
	readonly startedAt: string
	readonly finishedAt: string
	readonly guildPath: string
	readonly cycles: readonly CycleReport[]
	readonly terminatedBy: string
	readonly costUsd: number
	/** Every baseline that has been replaced, newest first. */
	readonly history: readonly string[]
}
