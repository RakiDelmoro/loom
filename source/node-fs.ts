/**
 * The real filesystem leaf.
 *
 * The only place the process touches disk directly. Everything else receives a
 * `FileSystem`, which is what keeps the fast test suite off the disk entirely.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { describeError } from './errors.ts'
import type { FileSystem, ListDirectoryResult, ReadTextFileResult } from './fs.ts'

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
		appendTextFile(filePath: string, text: string): void {
			appendFileSync(filePath, text, 'utf8')
		},
		listDirectory(dirPath: string): ListDirectoryResult {
			if (!existsSync(dirPath)) return { kind: 'unreadable', message: 'directory does not exist' }
			try {
				const entries = readdirSync(dirPath, { withFileTypes: true })
				return { kind: 'ok', entries: entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })) }
			} catch (error) {
				return { kind: 'unreadable', message: describeError(error) }
			}
		},
		isDirectory(dirPath: string): boolean {
			return statSync(dirPath, { throwIfNoEntry: false })?.isDirectory() ?? false
		},
		exists(filePath: string): boolean {
			return existsSync(filePath)
		},
		ensureDirectory(dirPath: string): void {
			mkdirSync(dirPath, { recursive: true })
		},
	}
}
