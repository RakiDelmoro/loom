import { describe, expect, test } from 'bun:test'
import { createSuiteResult } from '../test-support/suite.ts'
import { compare } from './compare.ts'

const options = { margin: 0.1, costMargin: 0.2 }

describe('compare', () => {
	test('a candidate whose lower bound clears the baseline plus the margin is improved', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		const candidate = createSuiteResult({ score: 1, low: 0.7, high: 1 })
		expect(compare(baseline, candidate, options).verdict).toBe('improved')
	})

	test('a candidate inside the interval is noise, however much bigger its point estimate', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		const candidate = createSuiteResult({ score: 0.7, low: 0.4, high: 0.9 })
		const comparison = compare(baseline, candidate, options)
		expect(comparison.verdict).toBe('noise')
		expect(comparison.reasons[0]).toContain('does not clear')
	})

	test('an identical candidate is noise, not an improvement', () => {
		const suite = createSuiteResult({ score: 0.75, low: 0.4, high: 0.9 })
		expect(compare(suite, suite, options).verdict).toBe('noise')
	})

	test('a candidate that clears the baseline but not the margin is noise', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		// 0.55 is above the baseline but inside the margin.
		const candidate = createSuiteResult({ score: 0.55, low: 0.55, high: 0.9 })
		expect(compare(baseline, candidate, options).verdict).toBe('noise')
	})

	test('a benchmark the baseline passed and the candidate does not is a regression, whatever the mean says', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0 } })
		const candidate = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 0, b: 1 } })

		const comparison = compare(baseline, candidate, options)
		// Averaging would call this a tie. A user would not.
		expect(comparison.verdict).toBe('regressed')
		expect(comparison.reasons[0]).toContain('regression on a')
	})

	test('regression is reported even when the mean also improved', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0, c: 0, d: 0 } })
		const candidate = createSuiteResult({ score: 0.75, low: 0.5, high: 1, benchmarks: { a: 0, b: 1, c: 1, d: 1 } })
		expect(compare(baseline, candidate, options).verdict).toBe('regressed')
	})

	test('a benchmark the candidate dropped entirely is not a regression', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0 } })
		const candidate = createSuiteResult({ score: 1, low: 0.8, high: 1, benchmarks: { a: 1 } })
		expect(compare(baseline, candidate, options).verdict).toBe('improved')
	})
})

describe('compare, when the score cannot go higher', () => {
	test('holding the score for materially less is an improvement', () => {
		// Measured: routing both roles to a cheaper model scored identically for
		// 2.6x less. Calling that noise throws the saving away.
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0437, repetitions: 3 })
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0166, repetitions: 3 })

		const comparison = compare(baseline, candidate, options)
		expect(comparison.verdict).toBe('improved')
		expect(comparison.reasons[0]).toContain('62% less')
	})

	test('the reason names the latency the saving cost', () => {
		// A cheaper candidate is not free if it is much slower, and the operator
		// reads the trade here rather than discovering it later.
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0437, repetitions: 3 })
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0166, repetitions: 3 })
		expect(compare(baseline, candidate, options).reasons[0]).toContain('s against')
	})

	test('a saving smaller than the margin is noise', () => {
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.04, repetitions: 3 })
		// 5% cheaper, against a 20% margin.
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.038, repetitions: 3 })
		expect(compare(baseline, candidate, options).verdict).toBe('noise')
	})

	test('cheaper is not enough if the score drops', () => {
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.04, benchmarks: { a: 1, b: 1 } })
		const candidate = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8, costUsd: 0.01, benchmarks: { a: 1, b: 0 } })
		expect(compare(baseline, candidate, options).verdict).toBe('regressed')
	})

	test('a saving measured once cannot be confirmed, and is not promoted', () => {
		// The bug this defends against: a candidate that set an option to the value
		// it already had measured 25% cheaper than the baseline it was identical to,
		// cleared a 20% margin, and was promoted. A real 15% saving in the same cycle
		// was not.
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0578, repetitions: 1 })
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0432, repetitions: 1 })

		const comparison = compare(baseline, candidate, options)
		expect(comparison.verdict).toBe('noise')
		// Said out loud, or it reads as the rule ignoring cost.
		expect(comparison.reasons.join(' ')).toContain('cannot be told from run-to-run variation')
	})

	test('the same saving with repetitions behind it is promoted', () => {
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0578, repetitions: 3 })
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0.0432, repetitions: 3 })
		expect(compare(baseline, candidate, options).verdict).toBe('improved')
	})

	test('a baseline that spends nothing has no saving to find', () => {
		// Both are free, so neither is cheaper — and promoting every tie would make
		// the loop churn forever.
		const baseline = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0, repetitions: 3 })
		const candidate = createSuiteResult({ score: 1, low: 0.65, high: 1, costUsd: 0, repetitions: 3 })
		expect(compare(baseline, candidate, options).verdict).toBe('noise')
	})

	test('a score win is reported as a score win, not as a saving', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8, costUsd: 0.04, repetitions: 3 })
		const candidate = createSuiteResult({ score: 1, low: 0.7, high: 1, costUsd: 0.01, repetitions: 3 })
		const comparison = compare(baseline, candidate, options)
		expect(comparison.verdict).toBe('improved')
		expect(comparison.reasons[0]).toContain('lower bound')
	})
})
