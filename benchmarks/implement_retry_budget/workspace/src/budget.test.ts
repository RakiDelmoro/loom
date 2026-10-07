import { expect, test } from 'bun:test'
import { spend } from './budget.ts'

test('returns what the operation produced', () => {
	expect(spend({ remaining: 2 }, () => 42)).toBe(42)
})

test('a successful call costs one unit', () => {
	const budget = { remaining: 2 }
	spend(budget, () => 'x')
	expect(budget.remaining).toBe(1)
})

test('a failed call costs one unit too', () => {
	const budget = { remaining: 2 }
	expect(() =>
		spend(budget, () => {
			throw new Error('nope')
		}),
	).toThrow('nope')
	expect(budget.remaining).toBe(1)
})

test('an exhausted budget refuses, and the operation never runs', () => {
	let calls = 0
	const budget = { remaining: 0 }
	expect(() =>
		spend(budget, () => {
			calls += 1
			return 'x'
		}),
	).toThrow()
	expect(calls).toBe(0)
	expect(budget.remaining).toBe(0)
})

test('the operation runs exactly once per call', () => {
	let calls = 0
	const budget = { remaining: 5 }
	spend(budget, () => {
		calls += 1
		return 'x'
	})
	expect(calls).toBe(1)
	expect(budget.remaining).toBe(4)
})

test('the budget is never charged more than the operation costs', () => {
	const budget = { remaining: 1 }
	spend(budget, () => 'x')
	expect(budget.remaining).toBe(0)
	// The next call is refused rather than going negative.
	expect(() => spend(budget, () => 'x')).toThrow()
	expect(budget.remaining).toBe(0)
})
