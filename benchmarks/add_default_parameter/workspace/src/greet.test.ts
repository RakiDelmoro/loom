import { expect, test } from 'bun:test'
import { greet } from './greet.ts'

test('greets with the default greeting', () => {
	expect(greet('Ada')).toBe('Hello, Ada!')
})

test('uses an explicit greeting when one is given', () => {
	expect(greet('Ada', 'Hi')).toBe('Hi, Ada!')
})
