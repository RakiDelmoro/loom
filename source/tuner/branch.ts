/**
 * Branch management: a candidate Blueprint on disk.
 *
 * A branch holds **exactly the files the Blueprint references** — the document,
 * each role's prompt and style guide, and each tool manifest. Not a directory
 * copy: the guild sits inside the project it describes, and copying the
 * directory would sweep up the repository around it.
 *
 * Each branch is then validated end to end with the same loader a run uses, so a
 * candidate that cannot run is never evaluated.
 */

import * as path from 'node:path'
import { loadBlueprint } from '../blueprint/load.ts'
import { parseBlueprintFile } from '../blueprint/parse.ts'
import type { BlueprintFile, LoadedBlueprint } from '../blueprint/types.ts'
import { ValidationError } from '../errors.ts'
import type { FileSystem } from '../fs.ts'
import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import { isSafeChangePath } from './hypothesis.ts'
import type { BlueprintChange } from './types.ts'

export const BLUEPRINT_FILE = 'loom.json'

const BRANCHES_DIRECTORY = 'branches'

/** Every file the Blueprint references, relative to the guild directory. */
export function blueprintFiles(blueprint: BlueprintFile): string[] {
	const files = new Set<string>([BLUEPRINT_FILE])
	for (const role of Object.values(blueprint.roles)) {
		files.add(role.prompt)
		if (role.styleGuide !== undefined) files.add(role.styleGuide)
	}
	for (const toolPath of blueprint.toolPaths) files.add(toolPath)
	return [...files].sort()
}

/** The files a guild directory holds, read from its own Blueprint. Empty when it will not parse. */
export function readBlueprintFiles(fs: FileSystem, guildPath: string): readonly string[] {
	const read = fs.readTextFile(path.join(guildPath, BLUEPRINT_FILE))
	if (read.kind !== 'ok') return []
	try {
		return blueprintFiles(parseBlueprintFile(JSON.parse(read.text), BLUEPRINT_FILE))
	} catch {
		// An unreadable guild has no file list; the caller reports the real problem.
		return []
	}
}

export interface BranchManager {
	/** The guild directory of a branch — what a benchmark run is pointed at. */
	guildPath(branchId: string): string
	create(branchId: string, changes: readonly BlueprintChange[], baselineGuildPath: string): OpResult<LoadedBlueprint>
	remove(branchId: string): void
	listBranches(): readonly string[]
}

export interface BranchManagerDependencies {
	readonly fs: FileSystem
	readonly removeDirectory: (directory: string) => void
}

export function createBranchManager(
	dependencies: BranchManagerDependencies,
	options: { readonly workspacePath: string },
): BranchManager {
	const { fs } = dependencies

	function branchRoot(branchId: string): string {
		return path.join(options.workspacePath, BRANCHES_DIRECTORY, branchId)
	}

	/** Writes `files` from `from` into `to`, creating directories as it goes. */
	function copyFiles(from: string, to: string, files: readonly string[]): void {
		for (const file of files) {
			const read = fs.readTextFile(path.join(from, file))
			if (read.kind !== 'ok') continue
			const target = path.join(to, file)
			fs.ensureDirectory(path.dirname(target))
			fs.writeTextFile(target, read.text)
		}
	}

	return {
		guildPath(branchId: string): string {
			return path.join(branchRoot(branchId), 'guild')
		},

		create(branchId: string, changes: readonly BlueprintChange[], baselineGuildPath: string): OpResult<LoadedBlueprint> {
			const guildPath = path.join(branchRoot(branchId), 'guild')
			let loaded: LoadedBlueprint
			dependencies.removeDirectory(branchRoot(branchId))
			fs.ensureDirectory(guildPath)
			copyFiles(baselineGuildPath, guildPath, readBlueprintFiles(fs, baselineGuildPath))

			for (const change of changes) {
				if (!isSafeChangePath(change.path)) {
					return failed(`"${change.path}" is not a path inside the guild directory`)
				}
				const target = path.join(guildPath, change.path)
				fs.ensureDirectory(path.dirname(target))
				fs.writeTextFile(target, change.content)
			}

			try {
				loaded = loadBlueprint({ readTextFile: fs.readTextFile }, path.join(guildPath, BLUEPRINT_FILE))
			} catch (error) {
				// A candidate that does not load is an ordinary outcome of a search,
				// not a fault: it is dropped, with its reason recorded.
				if (error instanceof ValidationError) return failed(error.message)
				throw error
			}

			// A change to a path the Blueprint does not reference is written and then
			// read by nothing, so the candidate is the baseline plus a stray file —
			// a no-op that scores identically and looks like a hypothesis that did
			// not help. Three cycles of the Tuner evaluated exactly that, in silence,
			// because the proposer guessed the Blueprint's filename.
			const referenced = new Set(readBlueprintFiles(fs, guildPath))
			for (const change of changes) {
				if (!referenced.has(change.path)) {
					return failed(
						`"${change.path}" is not referenced by the Blueprint, so changing it would have no effect. ` +
							`The Blueprint document is ${BLUEPRINT_FILE}, and the files a change may name are: ${[...referenced].sort().join(', ')}`,
					)
				}
			}

			return ok(loaded)
		},

		remove(branchId: string): void {
			dependencies.removeDirectory(branchRoot(branchId))
		},

		listBranches(): readonly string[] {
			const listed = fs.listDirectory(path.join(options.workspacePath, BRANCHES_DIRECTORY))
			if (listed.kind !== 'ok') return []
			return listed.entries
				.filter((entry) => entry.isDirectory)
				.map((entry) => entry.name)
				.sort()
		},
	}
}
