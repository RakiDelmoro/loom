/**
 * An in-memory `FileSystem` for tests: no disk, no cleanup, no teardown.
 *
 * Exposed from a support module rather than duplicated per test file, so every
 * test double behaves identically.
 */

import type { FileSystem, ReadTextFileResult } from '../fs.ts'

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
			isDirectory(dirPath: string): boolean {
				return directories.has(dirPath)
			},
			ensureDirectory(dirPath: string): void {
				directories.add(dirPath)
			},
		},
	}
}
