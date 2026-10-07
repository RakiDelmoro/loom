import { expect, test } from 'bun:test'
import { clamp } from './clamp.ts'

test('leaves a value inside the range alone', () => {
	expect(clamp(5, 0, 10)).toBe(5)
})

test('clamps a value below the minimum', () => {
	expect(clamp(-1, 0, 10)).toBe(0)
})

test('clamps a value above the maximum', () => {
	expect(clamp(99, 0, 10)).toBe(10)
})
