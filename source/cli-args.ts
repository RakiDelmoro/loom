/**
 * Command-line argument parsing.
 *
 * Deliberately minimal: `--name value` pairs, plus a declared set of boolean
 * switches. Anything not starting with `--` is a positional. A `--name` whose
 * next token is another flag, or absent, is treated as an empty string rather
 * than swallowing the flag after it.
 */

export interface ParsedArguments {
	readonly positionals: readonly string[]
	readonly flags: Readonly<Record<string, string>>
	readonly switches: readonly string[]
}

export function parseArguments(argv: readonly string[], booleanSwitches: readonly string[]): ParsedArguments {
	const positionals: string[] = []
	const flags: Record<string, string> = {}
	const switches: string[] = []

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

		const value = argv[index + 1]
		if (value === undefined || value.startsWith('--')) {
			flags[name] = ''
			continue
		}
		flags[name] = value
		index += 1
	}

	return { positionals, flags, switches }
}
