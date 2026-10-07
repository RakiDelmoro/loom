import { DEFAULT_TAGS } from './tags.ts'

/** The tags a publish carries, plus `published`. With no list, the defaults are used. */
export function publishTags(extra: string[] = DEFAULT_TAGS): string[] {
	extra.push('published')
	return extra
}
