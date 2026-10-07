import { describe, expect, test } from 'bun:test'
import { createSuiteResult } from '../test-support/suite.ts'
import { compare } from './compare.ts'

const margin = { margin: 0.1 }

describe('compare', () => {
	test('a candidate whose lower bound clears the baseline plus the margin is improved', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		const candidate = createSuiteResult({ score: 1, low: 0.7, high: 1 })
		expect(compare(baseline, candidate, margin).verdict).toBe('improved')
	})

	test('a candidate inside the interval is noise, however much bigger its point estimate', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		const candidate = createSuiteResult({ score: 0.7, low: 0.4, high: 0.9 })
		const comparison = compare(baseline, candidate, margin)
		expect(comparison.verdict).toBe('noise')
		expect(comparison.reasons[0]).toContain('does not clear')
	})

	test('an identical candidate is noise, not an improvement', () => {
		const suite = createSuiteResult({ score: 0.75, low: 0.4, high: 0.9 })
		expect(compare(suite, suite, margin).verdict).toBe('noise')
	})

	test('a candidate that clears the baseline but not the margin is noise', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.2, high: 0.8 })
		// 0.55 is above the baseline but inside the margin.
		const candidate = createSuiteResult({ score: 0.55, low: 0.55, high: 0.9 })
		expect(compare(baseline, candidate, margin).verdict).toBe('noise')
	})

	test('a benchmark the baseline passed and the candidate does not is a regression, whatever the mean says', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0 } })
		const candidate = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 0, b: 1 } })

		const comparison = compare(baseline, candidate, margin)
		// Averaging would call this a tie. A user would not.
		expect(comparison.verdict).toBe('regressed')
		expect(comparison.reasons[0]).toContain('regression on a')
	})

	test('regression is reported even when the mean also improved', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0, c: 0, d: 0 } })
		const candidate = createSuiteResult({ score: 0.75, low: 0.5, high: 1, benchmarks: { a: 0, b: 1, c: 1, d: 1 } })
		expect(compare(baseline, candidate, margin).verdict).toBe('regressed')
	})

	test('a benchmark the candidate dropped entirely is not a regression', () => {
		const baseline = createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1, b: 0 } })
		const candidate = createSuiteResult({ score: 1, low: 0.8, high: 1, benchmarks: { a: 1 } })
		expect(compare(baseline, candidate, margin).verdict).toBe('improved')
	})
})
