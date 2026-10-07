import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createToolRegistry } from './registry.ts'
import type { ToolRegistry } from './types.ts'
import { createWorkspaceToolHandlers } from './workspace.ts'

const context = { workspaceRoot: '/repo' }

function createTools(files: Readonly<Record<string, string>> = {}): ToolRegistry {
	const memory = createMemoryFileSystem(files, ['/repo'])
	return createToolRegistry(createWorkspaceToolHandlers({ fs: memory.fs }))
}

// Assertions compare whole result objects rather than reaching into `data`,
// whose type is deliberately `unknown` — a tool's payload is only ever as
// trustworthy as the tool.

describe('read_file', () => {
	test('returns the file contents with a workspace-relative path', async () => {
		const tools = createTools({ '/repo/src/a.ts': 'hello\n' })
		expect(await tools.run('read_file', { path: 'src/a.ts' }, context)).toEqual({
			kind: 'success',
			data: { path: 'src/a.ts', content: 'hello\n', truncated: false },
		})
	})

	test('reports a missing file rather than throwing', async () => {
		const tools = createTools()
		expect((await tools.run('read_file', { path: 'nope.ts' }, context)).kind).toBe('unavailable')
	})

	test('refuses a path that escapes the workspace', async () => {
		const tools = createTools({ '/repo/a.ts': 'x' })
		expect((await tools.run('read_file', { path: '../../etc/passwd' }, context)).kind).toBe('outside_workspace')
	})

	test('rejects a missing path argument', async () => {
		const tools = createTools()
		expect((await tools.run('read_file', {}, context)).kind).toBe('invalid_arguments')
	})
})

describe('write_file', () => {
	test('writes a file, creating its directory', async () => {
		const memory = createMemoryFileSystem({}, ['/repo'])
		const tools = createToolRegistry(createWorkspaceToolHandlers({ fs: memory.fs }))

		const result = await tools.run('write_file', { path: 'src/deep/a.ts', content: 'body' }, context)
		expect(result).toEqual({ kind: 'success', data: { path: 'src/deep/a.ts', bytes: 4 } })
		expect(memory.files.get('/repo/src/deep/a.ts')).toBe('body')
	})

	test('rejects a write that escapes the workspace, and writes nothing', async () => {
		const memory = createMemoryFileSystem({}, ['/repo'])
		const tools = createToolRegistry(createWorkspaceToolHandlers({ fs: memory.fs }))

		expect((await tools.run('write_file', { path: '../outside.ts', content: 'x' }, context)).kind).toBe('outside_workspace')
		expect(memory.files.size).toBe(0)
	})

	test('rejects a non-string content argument', async () => {
		const tools = createTools()
		expect((await tools.run('write_file', { path: 'a.ts', content: 7 }, context)).kind).toBe('invalid_arguments')
	})
})

describe('list_dir', () => {
	test('lists files and directories, files marked apart from directories', async () => {
		const tools = createTools({ '/repo/a.ts': 'a', '/repo/zdir/b.ts': 'b' })
		expect(await tools.run('list_dir', {}, context)).toEqual({
			kind: 'success',
			data: {
				path: '',
				entries: [
					{ name: 'a.ts', isDirectory: false },
					{ name: 'zdir', isDirectory: true },
				],
				truncated: false,
			},
		})
	})

	test('reports a missing directory', async () => {
		const tools = createTools({ '/repo/a.ts': 'a' })
		expect((await tools.run('list_dir', { path: 'ghost' }, context)).kind).toBe('unavailable')
	})
})

describe('glob', () => {
	test('matches workspace-relative paths', async () => {
		const tools = createTools({ '/repo/a.ts': '', '/repo/src/b.ts': '', '/repo/src/c.js': '' })
		expect(await tools.run('glob', { pattern: '**/*.ts' }, context)).toEqual({
			kind: 'success',
			data: { pattern: '**/*.ts', matches: ['a.ts', 'src/b.ts'], truncated: false },
		})
	})

	test('never descends into ignored directories', async () => {
		const tools = createTools({ '/repo/a.ts': '', '/repo/node_modules/b.ts': '', '/repo/.git/c.ts': '' })
		expect(await tools.run('glob', { pattern: '**/*.ts' }, context)).toEqual({
			kind: 'success',
			data: { pattern: '**/*.ts', matches: ['a.ts'], truncated: false },
		})
	})

	test('rejects an empty pattern', async () => {
		const tools = createTools()
		expect((await tools.run('glob', { pattern: '' }, context)).kind).toBe('invalid_arguments')
	})
})

describe('search', () => {
	test('reports the file and line of every match', async () => {
		const tools = createTools({ '/repo/a.ts': 'first\nneedle here\nlast\n' })
		expect(await tools.run('search', { query: 'needle' }, context)).toEqual({
			kind: 'success',
			data: { query: 'needle', matches: [{ path: 'a.ts', line: 2, text: 'needle here' }], truncated: false },
		})
	})

	test('limits the search to a path prefix', async () => {
		const tools = createTools({ '/repo/a.ts': 'needle', '/repo/src/b.ts': 'needle' })
		expect(await tools.run('search', { query: 'needle', path: 'src/' }, context)).toEqual({
			kind: 'success',
			data: { query: 'needle', matches: [{ path: 'src/b.ts', line: 1, text: 'needle' }], truncated: false },
		})
	})

	test('rejects an empty query', async () => {
		const tools = createTools()
		expect((await tools.run('search', { query: '' }, context)).kind).toBe('invalid_arguments')
	})
})
