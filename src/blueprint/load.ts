/**
 * Loads a Blueprint from disk: read the document, parse it, read and parse every
 * tool manifest it names, check the cross-references, and resolve every role's
 * system prompt (appending its style guide when it declares one).
 *
 * This is orchestration, not a leaf: the filesystem is injected, so the whole
 * loader is exercised in memory by the tests.
 */

import * as path from 'node:path'
import { ValidationError } from '../errors.ts'
import { parseBlueprintFile, parseToolManifest, validateBlueprint } from './parse.ts'
import type { ReadTextFileResult } from '../fs.ts'
import type { LoadedBlueprint, LoadedRole, RoleDefinition } from './types.ts'

export interface BlueprintLoaderDependencies {
	readonly readTextFile: (filePath: string) => ReadTextFileResult
}

export function loadBlueprint(dependencies: BlueprintLoaderDependencies, blueprintPath: string): LoadedBlueprint {
	const file = parseBlueprintFile(readJson(dependencies, blueprintPath), blueprintPath)
	const directory = path.dirname(blueprintPath)

	const manifests = file.toolPaths.map((relative) => {
		const manifestPath = path.resolve(directory, relative)
		return parseToolManifest(readJson(dependencies, manifestPath), manifestPath)
	})

	validateBlueprint(file, manifests, blueprintPath)

	const roles: Record<string, LoadedRole> = {}
	for (const [name, role] of Object.entries(file.roles)) {
		roles[name] = { ...role, systemPrompt: readRolePrompt(dependencies, directory, role, name, blueprintPath) }
	}

	return {
		entryRole: file.entryRole,
		roles,
		tools: manifests,
		routing: file.routing,
		budgets: file.budgets,
		permissions: file.permissions,
	}
}

/** Reads a role's prompt, appending its style guide when one is declared. */
function readRolePrompt(
	dependencies: BlueprintLoaderDependencies,
	directory: string,
	role: RoleDefinition,
	name: string,
	blueprintPath: string,
): string {
	const promptPath = path.resolve(directory, role.prompt)
	const prompt = readText(dependencies, promptPath, `${blueprintPath}.roles.${name}.prompt`)
	if (prompt.trim() === '') {
		throw new ValidationError(`${blueprintPath}.roles.${name}.prompt`, `prompt file "${role.prompt}" is empty`)
	}
	if (role.styleGuide === undefined) return prompt

	const guidePath = path.resolve(directory, role.styleGuide)
	const guide = readText(dependencies, guidePath, `${blueprintPath}.roles.${name}.styleGuide`)
	if (guide.trim() === '') {
		throw new ValidationError(`${blueprintPath}.roles.${name}.styleGuide`, `style guide "${role.styleGuide}" is empty`)
	}
	return `${prompt}\n\n${guide}`
}

function readText(dependencies: BlueprintLoaderDependencies, filePath: string, reportedPath: string): string {
	const result = dependencies.readTextFile(filePath)
	if (result.kind !== 'ok') throw new ValidationError(reportedPath, result.message)
	return result.text
}

// JSON.parse has no non-throwing form, so malformed JSON is the one condition
// that cannot be checked before it happens; it is caught here and re-thrown as a
// path-carrying ValidationError.
function readJson(dependencies: BlueprintLoaderDependencies, filePath: string): unknown {
	const text = readText(dependencies, filePath, filePath)
	try {
		return JSON.parse(text)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new ValidationError(filePath, `not valid JSON: ${detail}`)
	}
}
