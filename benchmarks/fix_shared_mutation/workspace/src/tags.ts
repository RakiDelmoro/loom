/** The tags a new item carries before anyone adds to them. */
export const DEFAULT_TAGS = ['draft']

/** Adds a tag to a list. With no list, the default tags are used. */
export function withTag(tags: string[] = DEFAULT_TAGS, tag: string): string[] {
	tags.push(tag)
	return tags
}
