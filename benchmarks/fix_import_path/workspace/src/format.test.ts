import { expect, test } from 'bun:test'
import { announce } from './format.ts'

test('announces in capitals', () => {
	expect(announce('hi')).toBe('HI')
})
