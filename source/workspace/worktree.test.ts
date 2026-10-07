import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createFakeGit, failed, ok } from '../test-support/fake-git.ts'
import type { GitResult } from './git.ts'
import { createWorktreeManager, parseWorktreeList } from './worktree.ts'

function createManager(
	respond: (args: readonly string[]) => GitResult | undefined,
	directories: readonly string[] = ['/repo', '/repo/.git'],
) {
	const git = createFakeGit(respond)
	const memory = createMemoryFileSystem({}, directories)
	const manager = createWorktreeManager({ git: git.runner, fs: memory.fs }, { repoPath: '/repo' })
	return { manager, git, memory }
}

describe('parseWorktreeList', () => {
	test('parses entries and strips the refs/heads prefix', () => {
		const porcelain = [
			'worktree /repo',
			'HEAD aaa',
			'branch refs/heads/main',
			'',
			'worktree /repo/.loom/worktrees/r/a',
			'HEAD bbb',
			'branch refs/heads/loom/r/a',
			'',
		].join('\n')
		expect(parseWorktreeList(porcelain)).toEqual([
			{ path: '/repo', branch: 'main' },
			{ path: '/repo/.loom/worktrees/r/a', branch: 'loom/r/a' },
		])
	})

	test('handles a detached worktree that has no branch line', () => {
		expect(parseWorktreeList('worktree /repo\nHEAD aaa\ndetached\n\n')).toEqual([{ path: '/repo', branch: null }])
	})

	test('handles a final entry with no trailing blank line', () => {
		expect(parseWorktreeList('worktree /repo\nbranch refs/heads/main')).toEqual([{ path: '/repo', branch: 'main' }])
	})
})

describe('resolveBaseSha', () => {
	test('trims the resolved commit', () => {
		const { manager } = createManager((args) => (args[0] === 'rev-parse' ? ok('abc123\n') : undefined))
		expect(manager.resolveBaseSha('HEAD')).toEqual({ kind: 'ok', value: 'abc123' })
	})

	test('fails when git resolves nothing', () => {
		const { manager } = createManager((args) => (args[0] === 'rev-parse' ? ok('\n') : undefined))
		expect(manager.resolveBaseSha('HEAD').kind).toBe('failed')
	})

	test('propagates a git failure', () => {
		const { manager } = createManager((args) => (args[0] === 'rev-parse' ? failed('not a git repository') : undefined))
		const result = manager.resolveBaseSha('HEAD')
		expect(result).toEqual({ kind: 'failed', message: 'not a git repository' })
	})
})

describe('create', () => {
	test('adds a worktree on its own branch, based on the given commit', () => {
		const { manager, git, memory } = createManager((args) => (args[0] === 'worktree' ? ok() : undefined))

		const result = manager.create('run-1', 'coder-0-1', 'abc123')
		if (result.kind !== 'ok') throw new Error(result.message)

		expect(result.value).toEqual({
			runId: 'run-1',
			agentId: 'coder-0-1',
			branch: 'loom/run-1/coder-0-1',
			path: '/repo/.loom/worktrees/run-1/coder-0-1',
			baseSha: 'abc123',
		})
		expect(git.commands).toEqual([
			['worktree', 'add', '-b', 'loom/run-1/coder-0-1', '/repo/.loom/worktrees/run-1/coder-0-1', 'abc123'],
		])
		// Creating a worktree also keeps the bookkeeping directory out of git's view.
		expect(memory.files.get('/repo/.git/info/exclude')).toBe('.loom/\n')
	})

	test('propagates a git failure without reporting a worktree', () => {
		const { manager } = createManager((args) => (args[0] === 'worktree' ? failed('branch already exists') : undefined))
		expect(manager.create('run-1', 'a', 'abc')).toEqual({ kind: 'failed', message: 'branch already exists' })
	})
})

describe('commit', () => {
	const worktree = {
		runId: 'run-1',
		agentId: 'coder-0-1',
		branch: 'loom/run-1/coder-0-1',
		path: '/repo/.loom/worktrees/run-1/coder-0-1',
		baseSha: 'base123',
	}

	test('returns null when the worktree is clean and the branch has not moved', () => {
		const { manager, git } = createManager((args) => {
			if (args.includes('status')) return ok('')
			if (args.includes('rev-parse')) return ok('base123\n')
			return undefined
		})

		expect(manager.commit(worktree, 'work')).toEqual({ kind: 'ok', value: null })
		expect(git.commands).toEqual([
			['-C', worktree.path, 'status', '--porcelain'],
			['-C', worktree.path, 'rev-parse', 'HEAD'],
		])
	})

	test('reports the branch tip when the tree is clean but the branch has moved', () => {
		// A clean tree is not the same as no work. Integrating a child commits a
		// merge into the caller's worktree, so a caller that changed nothing itself
		// is still carrying its children's work. Reporting null for it dropped the
		// whole branch at the end of the run and sent the children to the base one
		// at a time — where three benchmarks conflicted with each other.
		const { manager, git } = createManager((args) => {
			if (args.includes('status')) return ok('')
			if (args.includes('rev-parse')) return ok('merged123\n')
			return undefined
		})

		expect(manager.commit(worktree, 'work')).toEqual({ kind: 'ok', value: 'merged123' })
		// And it does not invent a commit for it: the merge is already committed.
		expect(git.commands.some((command) => command.includes('commit'))).toBe(false)
	})

	test('commits dirty work, records the trailers, and returns the new commit', () => {
		const { manager, git } = createManager((args) => {
			if (args.includes('status')) return ok(' M src/a.ts\n')
			if (args.includes('add')) return ok()
			if (args.includes('commit')) return ok('[main abc] work\n')
			if (args.includes('rev-parse')) return ok('deadbeef\n')
			return undefined
		})

		expect(manager.commit(worktree, 'work by coder-0-1')).toEqual({ kind: 'ok', value: 'deadbeef' })

		const commitCommand = git.commands.find((command) => command.includes('commit'))
		expect(commitCommand).toBeDefined()
		const message = commitCommand?.[commitCommand.length - 1] ?? ''
		expect(message).toContain('work by coder-0-1')
		expect(message).toContain('Loom-Run: run-1')
		expect(message).toContain('Loom-Agent: coder-0-1')
	})

	test('propagates a failure to stage', () => {
		const { manager } = createManager((args) => {
			if (args.includes('status')) return ok(' M a\n')
			if (args.includes('add')) return failed('index locked')
			return undefined
		})
		expect(manager.commit(worktree, 'work')).toEqual({ kind: 'failed', message: 'index locked' })
	})
})

describe('remove', () => {
	const worktree = { runId: 'run-1', agentId: 'a', branch: 'loom/run-1/a', path: '/repo/.loom/worktrees/run-1/a' }

	test('removes a worktree that exists', () => {
		const { manager, git } = createManager(
			(args) => (args[0] === 'worktree' ? ok() : undefined),
			['/repo', '/repo/.git', '/repo/.loom/worktrees/run-1/a'],
		)
		expect(manager.remove(worktree)).toEqual({ kind: 'ok', value: null })
		expect(git.commands).toEqual([['worktree', 'remove', '--force', worktree.path]])
	})

	test('is idempotent: an already-removed worktree prunes instead of failing', () => {
		const { manager, git } = createManager((args) => (args[0] === 'worktree' ? ok() : undefined))
		expect(manager.remove(worktree)).toEqual({ kind: 'ok', value: null })
		expect(git.commands).toEqual([['worktree', 'prune']])
	})
})

describe('removeRun', () => {
	const porcelain = [
		'worktree /repo',
		'HEAD aaa',
		'branch refs/heads/main',
		'',
		'worktree /repo/.loom/worktrees/run-1/a',
		'HEAD bbb',
		'branch refs/heads/loom/run-1/a',
		'',
		'worktree /repo/.loom/worktrees/run-2/b',
		'HEAD ccc',
		'branch refs/heads/loom/run-2/b',
		'',
	].join('\n')

	test('removes only the named run, and its branches when asked', () => {
		const { manager, git } = createManager(
			(args) => {
				if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain)
				if (args[0] === 'worktree') return ok()
				if (args[0] === 'branch') return ok()
				return undefined
			},
			['/repo', '/repo/.git', '/repo/.loom/worktrees/run-1/a', '/repo/.loom/worktrees/run-2/b'],
		)

		const result = manager.removeRun('run-1', { branches: true })
		expect(result).toEqual({ kind: 'ok', value: ['/repo/.loom/worktrees/run-1/a'] })

		const deletedBranches = git.commands.filter((command) => command[0] === 'branch').map((command) => command[2])
		expect(deletedBranches).toEqual(['loom/run-1/a'])
	})

	test('leaves branches alone when not asked to delete them', () => {
		const { manager, git } = createManager(
			(args) => {
				if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain)
				if (args[0] === 'worktree') return ok()
				return undefined
			},
			['/repo', '/repo/.git', '/repo/.loom/worktrees/run-1/a', '/repo/.loom/worktrees/run-2/b'],
		)

		manager.removeRun('run-1', { branches: false })
		expect(git.commands.some((command) => command[0] === 'branch')).toBe(false)
	})

	test('prunes once at the end, even when the run had no worktrees', () => {
		const { manager, git } = createManager(
			(args) => {
				if (args[0] === 'worktree' && args[1] === 'list') return ok('worktree /repo\nbranch refs/heads/main\n\n')
				if (args[0] === 'worktree') return ok()
				return undefined
			},
			['/repo', '/repo/.git'],
		)

		expect(manager.removeRun('run-9', { branches: true })).toEqual({ kind: 'ok', value: [] })
		expect(git.commands).toEqual([['worktree', 'list', '--porcelain'], ['worktree', 'prune']])
	})
})

describe('list', () => {
	test('returns the parsed worktrees', () => {
		const { manager } = createManager((args) => (args[0] === 'worktree' ? ok('worktree /repo\nbranch refs/heads/main\n\n') : undefined))
		expect(manager.list()).toEqual({ kind: 'ok', value: [{ path: '/repo', branch: 'main' }] })
	})

	test('propagates a git failure', () => {
		const { manager } = createManager((args) => (args[0] === 'worktree' ? failed('not a repository') : undefined))
		expect(manager.list().kind).toBe('failed')
	})
})
