import { expect, test } from 'bun:test'
import { publishTags } from './publish.ts'
import { DEFAULT_TAGS } from './tags.ts'

test('adds published to the list it is given', () => {
	expect(publishTags(['a'])).toEqual(['a', 'published'])
})

test('with no list, the default tags are used', () => {
	expect(publishTags()).toEqual(['draft', 'published'])
})

test('publishing does not change the default tags', () => {
	publishTags()
	publishTags()
	expect(DEFAULT_TAGS).toEqual(['draft'])
	expect(publishTags()).toEqual(['draft', 'published'])
})
