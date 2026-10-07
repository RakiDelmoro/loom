/**
 * Deciding whether a candidate is better.
 *
 * Two ways to win, in this order:
 *
 * 1. **Score.** A candidate is improved when the pessimistic end of its own
 *    interval still beats the baseline's measured score by the configured margin.
 *    Anything less is sampling variance, and a loop that treats a bigger number as
 *    progress chases that forever.
 * 2. **Cost, at no loss of score.** When the score cannot go higher — because the
 *    baseline already passes everything — the remaining axis is what it spends.
 *    A candidate that holds the score and costs materially less is an improvement,
 *    and calling it "noise" throws away a real saving: routing both roles to a
 *    cheaper model scored identically for 2.6x less, and this rule discarded it.
 *
 * A regression is checked first, so neither path can buy a win by breaking
 * something that already worked.
 */

import type { SuiteResult } from '../bench/types.ts'
import type { Verdict } from './types.ts'

export interface Comparison {
	readonly verdict: Verdict
	readonly reasons: readonly string[]
}

export interface ComparisonOptions {
	/** How far above the baseline's score the candidate's lower bound must reach. */
	readonly margin: number
	/** How much cheaper a candidate must be — in [0, 1) — to win on cost alone. */
	readonly costMargin: number
}

export function compare(baseline: SuiteResult, candidate: SuiteResult, options: ComparisonOptions): Comparison {
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

	// A baseline that spends nothing has no saving to find: every candidate would
	// tie at zero, and each of them would look like a win.
	if (baseline.costUsd > 0) {
		const ceiling = baseline.costUsd * (1 - options.costMargin)
		if (candidate.score >= baseline.score && candidate.costUsd < ceiling) {
			const saved = ((1 - candidate.costUsd / baseline.costUsd) * 100).toFixed(0)
			return {
				verdict: 'improved',
				reasons: [
					`the candidate held the score at ${candidate.score.toFixed(3)} for ${saved}% less ` +
						`($${baseline.costUsd.toFixed(4)} -> $${candidate.costUsd.toFixed(4)}), ` +
						// Latency is named because this is the trade the rule just made on the
						// operator's behalf: cheaper is not free if it is much slower.
						`in ${candidate.wallTimeSeconds.toFixed(0)}s against ${baseline.wallTimeSeconds.toFixed(0)}s`,
				],
			}
		}
	}

	return {
		verdict: 'noise',
		reasons: [
			`the candidate scored ${candidate.score.toFixed(3)} against a baseline of ${baseline.score.toFixed(3)}, but its interval [${candidate.interval.low.toFixed(3)}, ${candidate.interval.high.toFixed(3)}] does not clear ${required.toFixed(3)}, and it costs $${candidate.costUsd.toFixed(4)} against $${baseline.costUsd.toFixed(4)}`,
		],
	}
}
