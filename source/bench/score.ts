/**
 * Scoring a suite.
 *
 * Two rules carry the weight here.
 *
 * **A score without an interval is not a measurement.** LLM work is stochastic,
 * so a difference smaller than the interval is noise, and a loop that treats
 * noise as progress optimizes toward nothing.
 *
 * **Cost and latency are reported, not folded in.** Turning dollars into
 * "correctness points" needs an exchange rate, and inventing one in the harness
 * would be worse than exposing both numbers and letting the comparison rule
 * decide. The score stays a plain pass rate.
 */

import type { BenchmarkOutcome, BenchmarkSummary, Split } from './types.ts'

export interface Interval {
	readonly low: number
	readonly high: number
}

/**
 * The Wilson score interval for a proportion.
 *
 * Preferred over the normal approximation because it stays inside [0, 1] and
 * behaves sanely at small counts — which is exactly the regime a benchmark
 * suite lives in.
 */
export function wilsonInterval(successes: number, total: number, z = 1.96): Interval {
	if (total <= 0) return { low: 0, high: 0 }

	const proportion = successes / total
	const denominator = 1 + (z * z) / total
	const centre = proportion + (z * z) / (2 * total)
	const spread = z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total))

	return {
		low: Math.max(0, (centre - spread) / denominator),
		high: Math.min(1, (centre + spread) / denominator),
	}
}

export interface Aggregates {
	readonly score: number
	readonly interval: Interval
	readonly costUsd: number
	readonly wallTimeSeconds: number
}

export function aggregate(outcomes: readonly BenchmarkOutcome[]): Aggregates {
	let score = 0
	let costUsd = 0
	let wallTimeSeconds = 0
	for (const outcome of outcomes) {
		score += outcome.score
		costUsd += outcome.costUsd
		wallTimeSeconds += outcome.wallTimeSeconds
	}
	const total = outcomes.length
	const mean = total === 0 ? 0 : score / total
	return {
		score: mean,
		// Every outcome is 0 or 1, so this sum is a count of passes and the
		// interval is a Wilson interval over a proportion exactly — not the
		// approximation it was when a judge could score a run at 2/3.
		interval: wilsonInterval(score, total),
		costUsd,
		wallTimeSeconds,
	}
}

/** Groups outcomes by benchmark, preserving the suite's own order. */
export function summarize(
	outcomes: readonly BenchmarkOutcome[],
	order: readonly string[],
	split: Split,
): BenchmarkSummary[] {
	const grouped = new Map<string, BenchmarkOutcome[]>()
	for (const outcome of outcomes) {
		const existing = grouped.get(outcome.benchmark)
		if (existing === undefined) grouped.set(outcome.benchmark, [outcome])
		else existing.push(outcome)
	}

	const summaries: BenchmarkSummary[] = []
	for (const benchmark of order) {
		const runs = grouped.get(benchmark)
		if (runs === undefined) continue
		const passes = runs.filter((run) => run.status === 'pass').length
		summaries.push({
			benchmark,
			split,
			passes,
			runs: runs.length,
			passRate: runs.length === 0 ? 0 : passes / runs.length,
			costUsd: runs.reduce((total, run) => total + run.costUsd, 0),
		})
	}
	return summaries
}
