import { describe, expect, test } from 'bun:test'
import { aggregate, summarize, wilsonInterval } from './score.ts'
import type { BenchmarkOutcome, OutcomeStatus } from './types.ts'

function outcome(
	benchmark: string,
	repetition: number,
	status: OutcomeStatus,
	score: 0 | 1,
	costUsd: number,
	wallTimeSeconds: number,
): BenchmarkOutcome {
	return { benchmark, repetition, status, score, reasons: [], runId: 'run-1', workspace: null, costUsd, wallTimeSeconds }
}

describe('wilsonInterval', () => {
	test('brackets the observed proportion', () => {
		const interval = wilsonInterval(5, 10)
		expect(interval.low).toBeLessThan(0.5)
		expect(interval.high).toBeGreaterThan(0.5)
	})

	test('is narrower with more samples', () => {
		const few = wilsonInterval(5, 10)
		const many = wilsonInterval(50, 100)
		expect(many.high - many.low).toBeLessThan(few.high - few.low)
	})

	test('a unanimous small sample still admits doubt', () => {
		// The point of the interval: 3/3 is not evidence of 1.0.
		expect(wilsonInterval(3, 3).low).toBeLessThan(0.9)
	})

	test('stays inside [0, 1] at the extremes', () => {
		expect(wilsonInterval(0, 5).low).toBe(0)
		expect(wilsonInterval(5, 5).high).toBeLessThanOrEqual(1)
	})

	test('reports an empty interval for no samples', () => {
		expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 })
	})
})

describe('aggregate', () => {
	test('averages the scores and totals cost and time', () => {
		const result = aggregate([outcome('a', 1, 'pass', 1, 0.1, 2), outcome('a', 2, 'fail', 0, 0.2, 3)])
		expect(result.score).toBeCloseTo(0.5, 10)
		expect(result.costUsd).toBeCloseTo(0.3, 10)
		expect(result.wallTimeSeconds).toBeCloseTo(5, 10)
	})

	test('an empty run scores zero', () => {
		expect(aggregate([])).toEqual({ score: 0, interval: { low: 0, high: 0 }, costUsd: 0, wallTimeSeconds: 0 })
	})
})

describe('summarize', () => {
	test('groups outcomes by benchmark, in the suite order', () => {
		const summaries = summarize(
			[outcome('b', 1, 'pass', 1, 0, 0), outcome('a', 1, 'fail', 0, 0, 0)],
			['a', 'b'],
			'optimization',
		)
		expect(summaries.map((summary) => summary.benchmark)).toEqual(['a', 'b'])
		expect(summaries[0]?.passRate).toBe(0)
		expect(summaries[1]?.passRate).toBe(1)
	})

	test('counts passes against runs, not scores', () => {
		const summaries = summarize(
			[outcome('a', 1, 'pass', 1, 0, 0), outcome('a', 2, 'pass', 1, 0, 0), outcome('a', 3, 'fail', 0, 0, 0)],
			['a'],
			'optimization',
		)
		expect(summaries[0]?.passes).toBe(2)
		expect(summaries[0]?.runs).toBe(3)
	})
})
