/**
 * An in-memory `FileSystem` for tests: no disk, no cleanup, no teardown.
 *
 * Exposed from a support module rather than duplicated per test file, so every
 * test double behaves identically.
 */

import type { DirectoryEntry, FileSystem, ListDirectoryResult, ReadTextFileResult } from '../fs.ts'

export interface MemoryFileSystem {
	readonly fs: FileSystem
	readonly files: Map<string, string>
	readonly directories: Set<string>
}

export function createMemoryFileSystem(
	initialFiles: Readonly<Record<string, string>> = {},
	initialDirectories: readonly string[] = [],
): MemoryFileSystem {
	const files = new Map(Object.entries(initialFiles))
	const directories = new Set(initialDirectories)

	// The flat maps are projected back into directory listings on demand, so a
	// test only ever declares the paths it cares about.
	function listDirectory(dirPath: string): ListDirectoryResult {
		const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
		const found = new Map<string, boolean>()

		const record = (candidate: string): void => {
			if (!candidate.startsWith(prefix)) return
			const rest = candidate.slice(prefix.length)
			if (rest === '') return
			const separator = rest.indexOf('/')
			found.set(separator === -1 ? rest : rest.slice(0, separator), separator !== -1)
		}

		for (const filePath of files.keys()) record(filePath)
		for (const directory of directories) record(`${directory}/`)

		if (found.size === 0 && !directories.has(dirPath)) {
			return { kind: 'unreadable', message: 'directory does not exist' }
		}
		const entries: DirectoryEntry[] = [...found].map(([name, isDirectory]) => ({ name, isDirectory }))
		return { kind: 'ok', entries }
	}

	return {
		files,
		directories,
		fs: {
			readTextFile(filePath: string): ReadTextFileResult {
				const text = files.get(filePath)
				if (text === undefined) return { kind: 'unreadable', message: 'file does not exist' }
				return { kind: 'ok', text }
			},
			writeTextFile(filePath: string, text: string): void {
				files.set(filePath, text)
			},
			appendTextFile(filePath: string, text: string): void {
				files.set(filePath, `${files.get(filePath) ?? ''}${text}`)
			},
			listDirectory,
			isDirectory(dirPath: string): boolean {
				return directories.has(dirPath)
			},
			exists(filePath: string): boolean {
				return files.has(filePath) || directories.has(filePath)
			},
			ensureDirectory(dirPath: string): void {
				directories.add(dirPath)
			},
		},
	}
}
