import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { appendExcludeEntry, ensureOrchestrationExcluded, gitDirFromLinkFile } from './exclude.ts'

describe('gitDirFromLinkFile', () => {
	test('reads an absolute gitdir pointer', () => {
		expect(gitDirFromLinkFile('gitdir: /real/repo/.git/worktrees/one\n')).toBe('/real/repo/.git/worktrees/one')
	})

	test('reads a relative gitdir pointer', () => {
		expect(gitDirFromLinkFile('gitdir: ../repo/.git/worktrees/one\n')).toBe('../repo/.git/worktrees/one')
	})

	test('returns null when the file carries no pointer', () => {
		expect(gitDirFromLinkFile('something else\n')).toBeNull()
	})
})

describe('appendExcludeEntry', () => {
	test('appends the entry with a trailing newline', () => {
		expect(appendExcludeEntry('', '.loom/')).toBe('.loom/\n')
	})

	test('separates from content that does not end in a newline', () => {
		expect(appendExcludeEntry('# comment', '.loom/')).toBe('# comment\n.loom/\n')
	})

	test('returns null when the entry is already present', () => {
		expect(appendExcludeEntry('a\n.loom/\nb\n', '.loom/')).toBeNull()
	})

	test('ignores surrounding whitespace when checking for the entry', () => {
		expect(appendExcludeEntry('  .loom/  \n', '.loom/')).toBeNull()
	})
})

describe('ensureOrchestrationExcluded', () => {
	test('writes the entry into a normal checkout, then leaves it alone', () => {
		const memory = createMemoryFileSystem({ '/repo/.git/info/exclude': '# template\n' }, ['/repo/.git'])

		expect(ensureOrchestrationExcluded(memory.fs, '/repo')).toEqual({ kind: 'ok', updated: true })
		expect(memory.files.get('/repo/.git/info/exclude')).toBe('# template\n.loom/\n')

		// Idempotent: a second run must not rewrite a file the operator shares.
		expect(ensureOrchestrationExcluded(memory.fs, '/repo')).toEqual({ kind: 'ok', updated: false })
	})

	test('creates the exclude file when the checkout has none', () => {
		const memory = createMemoryFileSystem({}, ['/repo/.git'])
		expect(ensureOrchestrationExcluded(memory.fs, '/repo')).toEqual({ kind: 'ok', updated: true })
		expect(memory.files.get('/repo/.git/info/exclude')).toBe('.loom/\n')
		expect(memory.directories.has('/repo/.git/info')).toBe(true)
	})

	test('follows a linked worktree to its real git directory', () => {
		const memory = createMemoryFileSystem({ '/repo/.git': 'gitdir: /real/repo/.git/worktrees/one\n' }, [
			'/real/repo/.git/worktrees/one',
		])
		expect(ensureOrchestrationExcluded(memory.fs, '/repo')).toEqual({ kind: 'ok', updated: true })
		expect(memory.files.get('/real/repo/.git/worktrees/one/info/exclude')).toBe('.loom/\n')
	})

	test('resolves a relative gitdir against the checkout', () => {
		const memory = createMemoryFileSystem({ '/repo/.git': 'gitdir: ../real/.git/worktrees/one\n' }, [
			'/real/.git/worktrees/one',
		])
		ensureOrchestrationExcluded(memory.fs, '/repo')
		expect(memory.files.get('/real/.git/worktrees/one/info/exclude')).toBe('.loom/\n')
	})

	test('skips a directory that is not a git checkout rather than failing', () => {
		const memory = createMemoryFileSystem({}, ['/repo'])
		expect(ensureOrchestrationExcluded(memory.fs, '/repo').kind).toBe('skipped')
	})

	test('skips a .git file that carries no gitdir pointer', () => {
		const memory = createMemoryFileSystem({ '/repo/.git': 'not a link\n' })
		expect(ensureOrchestrationExcluded(memory.fs, '/repo').kind).toBe('skipped')
	})
})
