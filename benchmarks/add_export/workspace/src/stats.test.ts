import { expect, test } from 'bun:test'
import { total } from './stats.ts'

test('sums the values', () => {
	expect(total([1, 2, 3])).toBe(6)
})

test('an empty list sums to zero', () => {
	expect(total([])).toBe(0)
})
