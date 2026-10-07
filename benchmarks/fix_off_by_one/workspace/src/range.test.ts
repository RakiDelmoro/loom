import { expect, test } from 'bun:test'
import { range } from './range.ts'

test('produces count values, starting at zero', () => {
	expect(range(3)).toEqual([0, 1, 2])
})

test('an empty range is empty', () => {
	expect(range(0)).toEqual([])
})
