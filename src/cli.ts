#!/usr/bin/env bun
/**
 * The `loom` command.
 *
 * Thin glue only: it wires the real filesystem leaf to the tested modules and
 * chooses exit codes. No logic worth testing lives here.
 */

import { existsSync, readFileSync } from 'node:fs'
import pkg from '../package.json'
import { describeError, ValidationError } from './errors.ts'
import { loadBlueprint } from './blueprint/load.ts'
import type { ReadTextFileResult } from './blueprint/types.ts'

const VERSION: string = pkg.version

const USAGE = `loom — a git-native, concurrent, provider-agnostic multi-agent engine

Usage:
  loom --version
  loom --help
  loom blueprint validate <file>

Commands:
  blueprint validate <file>   Validate a Blueprint and every tool manifest it names.
`

function readTextFile(filePath: string): ReadTextFileResult {
	if (!existsSync(filePath)) return { kind: 'unreadable', message: 'file does not exist' }
	try {
		return { kind: 'ok', text: readFileSync(filePath, 'utf8') }
	} catch (error) {
		// Existence was checked above, so this is a genuine I/O fault.
		return { kind: 'unreadable', message: describeError(error) }
	}
}

function validateBlueprintCommand(filePath: string | undefined): number {
	if (filePath === undefined) {
		process.stderr.write('loom blueprint validate: missing <file>\n')
		return 2
	}
	try {
		const blueprint = loadBlueprint({ readTextFile }, filePath)
		const roles = Object.keys(blueprint.roles).length
		process.stdout.write(
			`${filePath}: ok — entry role "${blueprint.entryRole}", ${roles} role(s), ${blueprint.tools.length} tool(s)\n`,
		)
		return 0
	} catch (error) {
		if (error instanceof ValidationError) {
			process.stderr.write(`${filePath}: invalid\n  ${error.message}\n`)
			return 1
		}
		throw error
	}
}

function run(argv: readonly string[]): number {
	const command = argv[0]

	if (command === undefined || command === '--help' || command === '-h') {
		process.stdout.write(USAGE)
		return 0
	}
	if (command === '--version' || command === '-v') {
		process.stdout.write(`${VERSION}\n`)
		return 0
	}
	if (command === 'blueprint' && argv[1] === 'validate') {
		return validateBlueprintCommand(argv[2])
	}

	process.stderr.write(`loom: unknown command "${command}"\n\n${USAGE}`)
	return 2
}

process.exit(run(process.argv.slice(2)))
