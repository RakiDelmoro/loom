/**
 * Glob matching.
 *
 * A deliberately small subset — `*`, `?`, and `**` — because the pattern comes
 * from a model and a full glob implementation would be a liability, not a
 * feature. Paths are matched in their workspace-relative, slash-separated form.
 */

// Characters that mean something to a RegExp and must be escaped to stay literal.
const REGEXP_SPECIALS = '.+^${}()|[]\\'

export function globToRegExp(pattern: string): RegExp {
	let source = '^'
	let index = 0

	while (index < pattern.length) {
		const character = pattern[index]
		if (character === undefined) break

		if (character === '*') {
			if (pattern[index + 1] === '*') {
				// `**/` spans any number of directories, including none, so
				// `**/*.ts` matches `a.ts` as well as `src/deep/a.ts`.
				if (pattern[index + 2] === '/') {
					source += '(?:.*/)?'
					index += 3
					continue
				}
				source += '.*'
				index += 2
				continue
			}
			source += '[^/]*'
			index += 1
			continue
		}

		if (character === '?') {
			source += '[^/]'
			index += 1
			continue
		}

		source += REGEXP_SPECIALS.includes(character) ? `\\${character}` : character
		index += 1
	}

	return new RegExp(`${source}$`)
}
