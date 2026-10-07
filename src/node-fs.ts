/**
 * The real filesystem leaf.
 *
 * The only place the process touches disk directly. Everything else receives a
 * `FileSystem`, which is what keeps the fast test suite off the disk entirely.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { describeError } from './errors.ts'
import type { FileSystem, ReadTextFileResult } from './fs.ts'

export function createNodeFileSystem(): FileSystem {
	return {
		readTextFile(filePath: string): ReadTextFileResult {
			// Existence is checked first, so the catch below covers only a genuine
			// I/O fault rather than the ordinary "file is missing" case.
			if (!existsSync(filePath)) return { kind: 'unreadable', message: 'file does not exist' }
			try {
				return { kind: 'ok', text: readFileSync(filePath, 'utf8') }
			} catch (error) {
				return { kind: 'unreadable', message: describeError(error) }
			}
		},
		writeTextFile(filePath: string, text: string): void {
			writeFileSync(filePath, text, 'utf8')
		},
		isDirectory(dirPath: string): boolean {
			return statSync(dirPath, { throwIfNoEntry: false })?.isDirectory() ?? false
		},
		ensureDirectory(dirPath: string): void {
			mkdirSync(dirPath, { recursive: true })
		},
	}
}
