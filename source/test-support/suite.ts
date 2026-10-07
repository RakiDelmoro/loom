/**
 * `SuiteResult` fixtures, so a comparison can be tested without running anything.
 */

import type { BenchmarkSummary, BenchmarkOutcome, SuiteResult, Split } from '../bench/types.ts'

export interface SuiteFixtureOptions {
	readonly score: number
	readonly low?: number
	readonly high?: number
	/** Pass rate per benchmark, by name. */
	readonly benchmarks?: Readonly<Record<string, number>>
	readonly costUsd?: number
	readonly repetitions?: number
	readonly split?: Split
}

export function createSuiteResult(options: SuiteFixtureOptions): SuiteResult {
	const benchmarks: BenchmarkSummary[] = Object.entries(options.benchmarks ?? { 'a': options.score }).map(
		([benchmark, passRate]) => ({
			benchmark,
			split: options.split ?? 'optimization',
			passes: Math.round(passRate),
			runs: 1,
			passRate,
			costUsd: 0,
		}),
	)

	const outcomes: BenchmarkOutcome[] = benchmarks.map((summary) => ({
		benchmark: summary.benchmark,
		repetition: 1,
		status: summary.passRate >= 1 ? 'pass' : 'fail',
		score: summary.passRate,
		reasons: [],
		runId: 'run-1',
		costUsd: 0,
		wallTimeSeconds: 0,
	}))

	return {
		suitePath: '/suite',
		blueprintPath: '/guild/loom.json',
		split: options.split ?? 'optimization',
		repetitions: options.repetitions ?? 1,
		startedAt: '2026-10-07T00:00:00.000Z',
		finishedAt: '2026-10-07T00:00:01.000Z',
		benchmarks,
		outcomes,
		score: options.score,
		interval: { low: options.low ?? options.score, high: options.high ?? options.score },
		costUsd: options.costUsd ?? 0,
		wallTimeSeconds: 0,
	}
}
