/**
 * The workspace file tools.
 *
 * Every one of them confines its path to the agent's own worktree, so isolation
 * survives a model that passes a wrong or hostile path.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import { invalidArguments } from './arguments.ts'
import { globToRegExp } from './glob.ts'
import { resolveWorkspacePath, toRelativePath } from './path.ts'
import type { ToolHandler, ToolResult } from './types.ts'
import { DEFAULT_IGNORED_DIRECTORIES, walkFiles } from './walk.ts'

const MAX_READ_CHARS = 100_000
const MAX_MATCHES = 200
const MAX_WALK_FILES = 5_000
const MAX_LIST_ENTRIES = 500

export interface WorkspaceToolDependencies {
	readonly fs: FileSystem
}

export function createWorkspaceToolHandlers(dependencies: WorkspaceToolDependencies): readonly ToolHandler[] {
	const { fs } = dependencies
	return [createReadFileTool(fs), createWriteFileTool(fs), createListDirTool(fs), createGlobTool(fs), createSearchTool(fs)]
}

function createReadFileTool(fs: FileSystem): ToolHandler {
	return {
		name: 'read_file',
		async run(args, context): Promise<ToolResult> {
			const requested = args['path']
			if (typeof requested !== 'string') return invalidArguments('path must be a string')

			const resolved = resolveWorkspacePath(context.workspaceRoot, requested)
			if (resolved.kind !== 'ok') return { kind: 'outside_workspace', message: resolved.message }

			const read = fs.readTextFile(resolved.path)
			if (read.kind !== 'ok') return { kind: 'unavailable', message: read.message }

			const truncated = read.text.length > MAX_READ_CHARS
			return {
				kind: 'success',
				data: {
					path: toRelativePath(context.workspaceRoot, resolved.path),
					content: truncated ? read.text.slice(0, MAX_READ_CHARS) : read.text,
					truncated,
				},
			}
		},
	}
}

function createWriteFileTool(fs: FileSystem): ToolHandler {
	return {
		name: 'write_file',
		async run(args, context): Promise<ToolResult> {
			const requested = args['path']
			const content = args['content']
			if (typeof requested !== 'string') return invalidArguments('path must be a string')
			if (typeof content !== 'string') return invalidArguments('content must be a string')

			const resolved = resolveWorkspacePath(context.workspaceRoot, requested)
			if (resolved.kind !== 'ok') return { kind: 'outside_workspace', message: resolved.message }

			fs.ensureDirectory(path.dirname(resolved.path))
			fs.writeTextFile(resolved.path, content)
			return {
				kind: 'success',
				data: { path: toRelativePath(context.workspaceRoot, resolved.path), bytes: content.length },
			}
		},
	}
}

function createListDirTool(fs: FileSystem): ToolHandler {
	return {
		name: 'list_dir',
		async run(args, context): Promise<ToolResult> {
			const requested = args['path'] === undefined ? '.' : args['path']
			if (typeof requested !== 'string') return invalidArguments('path must be a string')

			const resolved = resolveWorkspacePath(context.workspaceRoot, requested)
			if (resolved.kind !== 'ok') return { kind: 'outside_workspace', message: resolved.message }

			const listed = fs.listDirectory(resolved.path)
			if (listed.kind !== 'ok') return { kind: 'unavailable', message: listed.message }

			const entries = [...listed.entries].sort((left, right) => left.name.localeCompare(right.name))
			return {
				kind: 'success',
				data: {
					path: toRelativePath(context.workspaceRoot, resolved.path),
					entries: entries.slice(0, MAX_LIST_ENTRIES),
					truncated: entries.length > MAX_LIST_ENTRIES,
				},
			}
		},
	}
}

function createGlobTool(fs: FileSystem): ToolHandler {
	return {
		name: 'glob',
		async run(args, context): Promise<ToolResult> {
			const pattern = args['pattern']
			if (typeof pattern !== 'string' || pattern === '') return invalidArguments('pattern must be a non-empty string')

			const matcher = globToRegExp(pattern)
			const files = walkFiles({ fs }, context.workspaceRoot, {
				maxFiles: MAX_WALK_FILES,
				ignoredDirectories: DEFAULT_IGNORED_DIRECTORIES,
			})
			const matches = files.filter((file) => matcher.test(file))
			return {
				kind: 'success',
				data: { pattern, matches: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES },
			}
		},
	}
}

function createSearchTool(fs: FileSystem): ToolHandler {
	return {
		name: 'search',
		async run(args, context): Promise<ToolResult> {
			const query = args['query']
			if (typeof query !== 'string' || query === '') return invalidArguments('query must be a non-empty string')
			const prefix = args['path'] === undefined ? '' : args['path']
			if (typeof prefix !== 'string') return invalidArguments('path must be a string')

			const files = walkFiles({ fs }, context.workspaceRoot, {
				maxFiles: MAX_WALK_FILES,
				ignoredDirectories: DEFAULT_IGNORED_DIRECTORIES,
			})

			const matches: Array<{ path: string; line: number; text: string }> = []
			for (const file of files) {
				if (matches.length >= MAX_MATCHES) break
				if (prefix !== '' && !file.startsWith(prefix)) continue

				const read = fs.readTextFile(path.join(context.workspaceRoot, file))
				if (read.kind !== 'ok') continue

				for (const [index, line] of read.text.split('\n').entries()) {
					if (!line.includes(query)) continue
					matches.push({ path: file, line: index + 1, text: line.slice(0, 200) })
					if (matches.length >= MAX_MATCHES) break
				}
			}

			return {
				kind: 'success',
				data: { query, matches, truncated: matches.length >= MAX_MATCHES },
			}
		},
	}
}
