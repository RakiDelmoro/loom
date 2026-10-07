/**
 * What a benchmark is, and what running one produces.
 *
 * A benchmark is a self-contained task: an initial workspace, a plain-language
 * task, and a machine-checkable definition of done. Its spec is never copied
 * into the workspace — the candidate must not be able to read the test it is
 * graded against.
 */

export type Split = 'optimization' | 'held-out'

export type Difficulty = 'easy' | 'medium' | 'hard'

export interface ValidationSpec {
	/** A shell command run in the finished workspace. */
	readonly command: string
	readonly expectedExitCode: number
	/** Files that must exist when the run is over. */
	readonly expectedFiles: readonly string[]
	/** Substrings that must appear in the command's stdout. */
	readonly expectedStdoutContains: readonly string[]
	readonly timeoutSeconds: number
}

export interface BenchmarkSpec {
	readonly id: string
	readonly taskType: string
	readonly difficulty: Difficulty
	/** The text handed to the entry role. */
	readonly task: string
	readonly validation: ValidationSpec
}

/** Which benchmarks the optimizer may see, and which it never may. */
export interface SuiteConfig {
	readonly optimization: readonly string[]
	readonly heldOut: readonly string[]
}

export type OutcomeStatus = 'pass' | 'fail' | 'error'

/** One benchmark, run once. */
export interface BenchmarkOutcome {
	readonly benchmark: string
	readonly repetition: number
	readonly status: OutcomeStatus
	/**
	 * 1 for a pass, 0 otherwise.
	 *
	 * Binary rather than a graded score, ever since the Bench stopped having a
	 * judge: which is what lets the suite's interval be an exact Wilson interval
	 * over a proportion rather than an approximation of one.
	 */
	readonly score: 0 | 1
	readonly reasons: readonly string[]
	readonly runId: string | null
	/**
	 * Where the run happened, when the sandbox was kept.
	 *
	 * A benchmark's workspace holds the run's own record under `.loom/runs/`, so
	 * this is the pointer that makes a finished suite openable in the UI. It is
	 * null when the sandbox was removed, because a path to a deleted directory is
	 * worse than no path at all.
	 */
	readonly workspace: string | null
	readonly costUsd: number
	readonly wallTimeSeconds: number
}

/** One benchmark, aggregated over its repetitions. */
export interface BenchmarkSummary {
	readonly benchmark: string
	readonly split: Split
	readonly passes: number
	readonly runs: number
	readonly passRate: number
	readonly costUsd: number
}

export interface SuiteResult {
	readonly suitePath: string
	readonly blueprintPath: string
	readonly split: Split
	readonly repetitions: number
	readonly startedAt: string
	readonly finishedAt: string
	readonly benchmarks: readonly BenchmarkSummary[]
	readonly outcomes: readonly BenchmarkOutcome[]
	/** The mean score across every run in the split. */
	readonly score: number
	/** A 95% Wilson interval over those runs. A smaller gap is not an improvement. */
	readonly interval: { readonly low: number; readonly high: number }
	readonly costUsd: number
	readonly wallTimeSeconds: number
}
