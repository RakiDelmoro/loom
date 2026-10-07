/**
 * Workspace traversal.
 *
 * Shared by `glob` and `search`. The result is sorted, so a model that repeats
 * a call sees the same list and the run stays reproducible.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'

export const DEFAULT_IGNORED_DIRECTORIES = ['.git', 'node_modules', '.loom'] as const

export interface WalkDependencies {
	readonly fs: FileSystem
}

export interface WalkOptions {
	readonly maxFiles: number
	/** Directory names never descended into. */
	readonly ignoredDirectories: readonly string[]
}

/**
 * Every file under `root`, as workspace-relative slash-separated paths, sorted.
 * An unreadable directory is skipped rather than failing the walk.
 */
export function walkFiles(dependencies: WalkDependencies, root: string, options: WalkOptions): string[] {
	const files: string[] = []
	const pending: string[] = ['']

	while (pending.length > 0 && files.length < options.maxFiles) {
		const relativeDirectory = pending.pop()
		if (relativeDirectory === undefined) break

		const absoluteDirectory = relativeDirectory === '' ? root : path.join(root, relativeDirectory)
		const listed = dependencies.fs.listDirectory(absoluteDirectory)
		if (listed.kind !== 'ok') continue

		for (const entry of listed.entries) {
			const relative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
			if (entry.isDirectory) {
				if (options.ignoredDirectories.includes(entry.name)) continue
				pending.push(relative)
				continue
			}
			if (files.length >= options.maxFiles) break
			files.push(relative)
		}
	}

	return files.sort()
}
