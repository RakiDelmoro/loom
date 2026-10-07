/**
 * Promotion: the only writer of the baseline.
 *
 * Two rules make it safe to leave running.
 *
 * **History is never overwritten.** The outgoing baseline is archived before the
 * new one is written, so a promotion that goes wrong is one `restore` away from
 * being undone.
 *
 * **Nothing else writes the baseline.** Branch directories are separate copies,
 * so a failed evaluation cannot leave the baseline half-rewritten.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import { readBlueprintFiles } from './branch.ts'

const BRANCHES_DIRECTORY = 'branches'
const HISTORY_DIRECTORY = 'history'

export interface Promoter {
	/** Replaces the baseline with a branch's guild, returning the history entry. */
	promote(branchId: string): OpResult<string>
	/** Every archived baseline, newest first. */
	history(): readonly string[]
	restore(entry: string): OpResult<null>
}

export interface PromoterDependencies {
	readonly fs: FileSystem
	readonly now: () => number
}

export function createPromoter(
	dependencies: PromoterDependencies,
	options: { readonly guildPath: string; readonly workspacePath: string },
): Promoter {
	const { fs } = dependencies

	function historyPath(entry: string): string {
		return path.join(options.workspacePath, HISTORY_DIRECTORY, entry)
	}

	/** Writes a guild's own files into another directory, leaving anything unreferenced alone. */
	function copyGuildInto(from: string, to: string): void {
		for (const file of readBlueprintFiles(fs, from)) {
			const read = fs.readTextFile(path.join(from, file))
			if (read.kind !== 'ok') continue
			const target = path.join(to, file)
			fs.ensureDirectory(path.dirname(target))
			fs.writeTextFile(target, read.text)
		}
	}

	return {
		promote(branchId: string): OpResult<string> {
			const branchGuild = path.join(options.workspacePath, BRANCHES_DIRECTORY, branchId, 'guild')
			if (!fs.isDirectory(branchGuild)) return failed(`no branch "${branchId}" to promote`)

			const entry = new Date(dependencies.now()).toISOString().replace(/[:.]/g, '-')
			const archive = historyPath(entry)

			// Archive first: if the second copy fails, the previous baseline is
			// still on disk and still recoverable.
			fs.ensureDirectory(archive)
			copyGuildInto(options.guildPath, archive)
			copyGuildInto(branchGuild, options.guildPath)
			return ok(entry)
		},

		history(): readonly string[] {
			const listed = fs.listDirectory(path.join(options.workspacePath, HISTORY_DIRECTORY))
			if (listed.kind !== 'ok') return []
			return listed.entries
				.filter((entry) => entry.isDirectory)
				.map((entry) => entry.name)
				.sort()
				.reverse()
		},

		restore(entry: string): OpResult<null> {
			const archive = historyPath(entry)
			if (!fs.isDirectory(archive)) return failed(`no history entry "${entry}"`)
			copyGuildInto(archive, options.guildPath)
			return ok(null)
		},
	}
}
