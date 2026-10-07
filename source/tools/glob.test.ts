import { describe, expect, test } from 'bun:test'
import { globToRegExp } from './glob.ts'

describe('globToRegExp', () => {
	test('`*` stays within one path segment', () => {
		const matcher = globToRegExp('*.ts')
		expect(matcher.test('a.ts')).toBe(true)
		expect(matcher.test('src/a.ts')).toBe(false)
	})

	test('`**/` spans any number of directories, including none', () => {
		const matcher = globToRegExp('**/*.ts')
		expect(matcher.test('a.ts')).toBe(true)
		expect(matcher.test('src/a.ts')).toBe(true)
		expect(matcher.test('src/deep/a.ts')).toBe(true)
		expect(matcher.test('a.js')).toBe(false)
	})

	test('a literal prefix constrains the match', () => {
		const matcher = globToRegExp('src/*.json')
		expect(matcher.test('src/a.json')).toBe(true)
		expect(matcher.test('src/deep/a.json')).toBe(false)
		expect(matcher.test('other/a.json')).toBe(false)
	})

	test('`?` matches exactly one non-separator character', () => {
		const matcher = globToRegExp('a?.ts')
		expect(matcher.test('ab.ts')).toBe(true)
		expect(matcher.test('a.ts')).toBe(false)
		expect(matcher.test('a/b.ts')).toBe(false)
	})

	test('regex metacharacters in the pattern are literal', () => {
		const matcher = globToRegExp('a.b.ts')
		expect(matcher.test('a.b.ts')).toBe(true)
		expect(matcher.test('axb.ts')).toBe(false)
	})

	test('the whole path must match', () => {
		expect(globToRegExp('a.ts').test('a.ts.bak')).toBe(false)
	})
})
