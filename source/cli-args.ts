/**
 * Command-line argument parsing.
 *
 * Deliberately minimal: `--name value` pairs, a declared set of boolean
 * switches, and a declared set of repeatable flags. Anything not starting with
 * `--` is a positional. A `--name` whose next token is another flag, or absent,
 * is treated as an empty string rather than swallowing the flag after it.
 */

import type { OpResult } from './result.ts'
import { failed, ok } from './result.ts'

export interface ParsedArguments {
	readonly positionals: readonly string[]
	readonly flags: Readonly<Record<string, string>>
	readonly switches: readonly string[]
	/** Values of the flags declared repeatable, in the order they appeared. */
	readonly repeated: Readonly<Record<string, readonly string[]>>
}

export function parseArguments(
	argv: readonly string[],
	booleanSwitches: readonly string[],
	repeatedFlags: readonly string[] = [],
): ParsedArguments {
	const positionals: string[] = []
	const flags: Record<string, string> = {}
	const switches: string[] = []
	const repeated: Record<string, string[]> = {}

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		if (token === undefined) continue

		if (!token.startsWith('--')) {
			positionals.push(token)
			continue
		}

		const name = token.slice(2)
		if (booleanSwitches.includes(name)) {
			switches.push(name)
			continue
		}

		const candidate = argv[index + 1]
		const hasValue = candidate !== undefined && !candidate.startsWith('--')
		const value = hasValue ? candidate : ''
		if (hasValue) index += 1

		if (repeatedFlags.includes(name)) {
			const existing = repeated[name]
			if (existing === undefined) repeated[name] = [value]
			else existing.push(value)
			continue
		}
		flags[name] = value
	}

	return { positionals, flags, switches, repeated }
}

/**
 * Parses `role=profile` pairs. Validating the names against the Blueprint is a
 * separate step — this only guarantees the shape.
 */
export function parseModelOverrides(values: readonly string[]): OpResult<Record<string, string>> {
	const overrides: Record<string, string> = {}
	for (const value of values) {
		const separator = value.indexOf('=')
		if (separator <= 0 || separator === value.length - 1) {
			return failed(`--model-override expects role=profile, got "${value}"`)
		}
		overrides[value.slice(0, separator)] = value.slice(separator + 1)
	}
	return ok(overrides)
}
