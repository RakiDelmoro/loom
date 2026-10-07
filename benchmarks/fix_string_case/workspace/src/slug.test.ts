import { expect, test } from 'bun:test'
import { slug } from './slug.ts'

test('lower-cases the slug', () => {
	expect(slug('Hello World')).toBe('hello-world')
})

test('collapses runs of whitespace into one dash', () => {
	expect(slug('a   b')).toBe('a-b')
})
