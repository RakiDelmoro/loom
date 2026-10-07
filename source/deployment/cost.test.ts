import { describe, expect, test } from 'bun:test'
import { addUsage, computeCost, ZERO_PRICE, ZERO_USAGE } from './cost.ts'

const PRICE = { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 }

describe('computeCost', () => {
	test('bills uncached input at the full rate and cached input at the cached rate', () => {
		// One million prompt tokens, of which 400k were served from cache.
		const cost = computeCost(PRICE, { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 })
		expect(cost).toBeCloseTo(0.6 * 3 + 0.4 * 0.3, 10)
	})

	test('does not bill cached tokens a second time at the full rate', () => {
		// The classic way to overstate a bill: charging the whole prompt at the
		// full rate *and* the cached subset again.
		const fullyCached = computeCost(PRICE, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })
		expect(fullyCached).toBeCloseTo(0.3, 10)
	})

	test('bills output tokens', () => {
		expect(computeCost(PRICE, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(15, 10)
	})

	test('a zero-priced model costs nothing', () => {
		expect(computeCost(ZERO_PRICE, { inputTokens: 9_000_000, cachedInputTokens: 1_000, outputTokens: 9_000_000 })).toBe(0)
	})

	test('an empty usage costs nothing', () => {
		expect(computeCost(PRICE, ZERO_USAGE)).toBe(0)
	})

	test('a fractional call is billed proportionally', () => {
		expect(computeCost(PRICE, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(0.0015, 12)
	})
})

describe('addUsage', () => {
	test('sums every field', () => {
		expect(
			addUsage(
				{ inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 },
				{ inputTokens: 10, cachedInputTokens: 20, outputTokens: 30 },
			),
		).toEqual({ inputTokens: 11, cachedInputTokens: 22, outputTokens: 33 })
	})
})
