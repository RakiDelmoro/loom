import { expect, test } from 'bun:test'
import { DEFAULT_TAGS, withTag } from './tags.ts'

test('adds a tag to the list it is given', () => {
	expect(withTag(['a'], 'b')).toEqual(['a', 'b'])
})

test('with no list, the default tags are used', () => {
	expect(withTag(undefined, 'urgent')).toEqual(['draft', 'urgent'])
})

test('using the defaults does not change the defaults', () => {
	withTag(undefined, 'urgent')
	expect(DEFAULT_TAGS).toEqual(['draft'])
	expect(withTag(undefined, 'later')).toEqual(['draft', 'later'])
})
