import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createNodeFileSystem } from '../node-fs.ts'
import { createGitRunner } from './git.ts'
import { createWorktreeManager, type CreatedWorktree, type WorktreeManager } from './worktree.ts'

/**
 * The one lane where real git runs.
 *
 * It touches the disk and spawns subprocesses, which the fast suite must never
 * do, so it is opt-in: `bun run test:git` sets LOOM_GIT_TESTS. Run it before
 * trusting a change to the worktree manager — isolation is a property of real
 * git and cannot be proven against a fake.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

function git(cwd: string, args: readonly string[]): string {
	const spawned = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
	if (spawned.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${spawned.stderr ?? ''}`)
	return spawned.stdout ?? ''
}

function createRepository(): string {
	const repo = mkdtempSync(path.join(tmpdir(), 'loom-git-'))
	git(repo, ['init', '-q', '-b', 'main'])
	writeFileSync(path.join(repo, 'README.md'), 'base\n')
	git(repo, ['add', '-A'])
	git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'initial'])
	return repo
}

function createWorktreeOrThrow(manager: WorktreeManager, agentId: string, baseSha: string): CreatedWorktree {
	const result = manager.create('run-1', agentId, baseSha)
	if (result.kind !== 'ok') throw new Error(result.message)
	return result.value
}

suite('the worktree manager against real git', () => {
	let cleanupPath: string | null = null

	afterEach(() => {
		if (cleanupPath !== null) rmSync(cleanupPath, { recursive: true, force: true })
		cleanupPath = null
	})

	test('isolates three agents, commits each to its own branch, and cleans up completely', () => {
		const repo = createRepository()
		cleanupPath = repo

		const manager = createWorktreeManager(
			{ git: createGitRunner({ cwd: repo }), fs: createNodeFileSystem() },
			{ repoPath: repo },
		)

		const base = manager.resolveBaseSha('HEAD')
		if (base.kind !== 'ok') throw new Error(base.message)

		const alice = createWorktreeOrThrow(manager, 'alice', base.value)
		const bob = createWorktreeOrThrow(manager, 'bob', base.value)
		const carol = createWorktreeOrThrow(manager, 'carol', base.value)

		// Each agent writes only inside its own worktree.
		writeFileSync(path.join(alice.path, 'alice.txt'), 'alice\n')
		writeFileSync(path.join(bob.path, 'bob.txt'), 'bob\n')
		writeFileSync(path.join(carol.path, 'carol.txt'), 'carol\n')

		// The whole premise: no agent sees another agent's file, and the base tree
		// sees none of them.
		expect(existsSync(path.join(alice.path, 'bob.txt'))).toBe(false)
		expect(existsSync(path.join(bob.path, 'alice.txt'))).toBe(false)
		expect(existsSync(path.join(repo, 'alice.txt'))).toBe(false)
		expect(existsSync(path.join(repo, 'bob.txt'))).toBe(false)

		const aliceCommit = manager.commit(alice, 'work by alice')
		const bobCommit = manager.commit(bob, 'work by bob')
		const carolCommit = manager.commit(carol, 'work by carol')
		if (aliceCommit.kind !== 'ok' || bobCommit.kind !== 'ok' || carolCommit.kind !== 'ok') {
			throw new Error('a commit failed')
		}

		const shas = [aliceCommit.value, bobCommit.value, carolCommit.value]
		expect(shas).not.toContain(null)
		expect(new Set(shas).size).toBe(3)

		// Each commit sits on its own branch and names the agent that made it.
		expect(git(alice.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('loom/run-1/alice')
		expect(git(alice.path, ['log', '-1', '--format=%B'])).toContain('Loom-Agent: alice')
		expect(git(alice.path, ['log', '-1', '--format=%B'])).toContain('Loom-Run: run-1')

		// The base tree never moved: still on main, still without the agents' work.
		expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
		expect(git(repo, ['log', '--format=%s', 'main'])).not.toContain('work by alice')
		expect(git(repo, ['status', '--porcelain']).trim()).toBe('')

		// Bookkeeping is excluded, so `.loom/` never appears in git's view.
		expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.loom/')
		expect(git(repo, ['status', '--porcelain'])).not.toContain('.loom')

		// Cleanup removes every worktree of the run and its branches.
		const removed = manager.removeRun('run-1', { branches: true })
		if (removed.kind !== 'ok') throw new Error(removed.message)
		expect(removed.value).toHaveLength(3)

		expect(existsSync(alice.path)).toBe(false)
		expect(existsSync(bob.path)).toBe(false)
		expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('run-1')
		expect(git(repo, ['branch', '--list', '--format=%(refname:short)'])).not.toContain('loom/run-1')

		// The repository is left pristine.
		expect(git(repo, ['status', '--porcelain']).trim()).toBe('')
		expect(existsSync(path.join(repo, 'alice.txt'))).toBe(false)
	})

	test('a worktree with no changes produces no commit', () => {
		const repo = createRepository()
		cleanupPath = repo

		const manager = createWorktreeManager(
			{ git: createGitRunner({ cwd: repo }), fs: createNodeFileSystem() },
			{ repoPath: repo },
		)
		const base = manager.resolveBaseSha('HEAD')
		if (base.kind !== 'ok') throw new Error(base.message)

		const worktree = createWorktreeOrThrow(manager, 'idle', base.value)
		expect(manager.commit(worktree, 'nothing to do')).toEqual({ kind: 'ok', value: null })
	})

	test('cleanup is safe to run twice', () => {
		const repo = createRepository()
		cleanupPath = repo

		const manager = createWorktreeManager(
			{ git: createGitRunner({ cwd: repo }), fs: createNodeFileSystem() },
			{ repoPath: repo },
		)
		const base = manager.resolveBaseSha('HEAD')
		if (base.kind !== 'ok') throw new Error(base.message)
		createWorktreeOrThrow(manager, 'alice', base.value)

		expect(manager.removeRun('run-1', { branches: true }).kind).toBe('ok')
		expect(manager.removeRun('run-1', { branches: true }).kind).toBe('ok')
		expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('run-1')
	})
})
