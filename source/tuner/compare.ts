/**
 * Deciding whether a candidate is better.
 *
 * The rule is deliberately conservative: **a candidate is improved only when the
 * pessimistic end of its own interval still beats the baseline's measured score
 * by the configured margin.** Anything else is noise.
 *
 * A loop that treats a bigger number as progress will chase sampling variance
 * forever and report a rising metric that means nothing. Making the comparison
 * interval arithmetic rather than a threshold comparison is the whole defence.
 */

import type { SuiteResult } from '../bench/types.ts'
import type { Verdict } from './types.ts'

export interface Comparison {
	readonly verdict: Verdict
	readonly reasons: readonly string[]
}

export function compare(baseline: SuiteResult, candidate: SuiteResult, options: { readonly margin: number }): Comparison {
	const reasons: string[] = []

	// A benchmark the baseline passed and the candidate does not is a regression,
	// whatever the aggregate says. Averaging hides exactly the damage a user
	// would notice.
	const baselineByBenchmark = new Map(baseline.benchmarks.map((summary) => [summary.benchmark, summary.passRate]))
	for (const summary of candidate.benchmarks) {
		const was = baselineByBenchmark.get(summary.benchmark)
		if (was === undefined) continue
		if (summary.passRate < was) {
			reasons.push(`regression on ${summary.benchmark}: ${String(was)} -> ${String(summary.passRate)}`)
		}
	}
	if (reasons.length > 0) return { verdict: 'regressed', reasons }

	const required = baseline.score + options.margin
	if (candidate.interval.low >= required) {
		return {
			verdict: 'improved',
			reasons: [
				`the candidate's lower bound ${candidate.interval.low.toFixed(3)} clears the baseline ${baseline.score.toFixed(3)} plus the ${options.margin.toFixed(3)} margin`,
			],
		}
	}

	return {
		verdict: 'noise',
		reasons: [
			`the candidate scored ${candidate.score.toFixed(3)} against a baseline of ${baseline.score.toFixed(3)}, but its interval [${candidate.interval.low.toFixed(3)}, ${candidate.interval.high.toFixed(3)}] does not clear ${required.toFixed(3)}`,
		],
	}
}
