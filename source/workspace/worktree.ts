/**
 * The worktree manager: one isolated working copy per agent.
 *
 * This is the isolation primitive the whole project rests on. Each agent gets
 * its own git worktree on its own branch, branched from a pinned commit, so
 * agents cannot see or corrupt each other's files and every agent's work is
 * reviewable and reversible on its own branch.
 *
 * Orchestration only: git and the filesystem arrive as dependencies, so every
 * command sequence, failure path, and cleanup rule is exercised in memory.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import { ensureOrchestrationExcluded } from './exclude.ts'
import type { GitRunner } from './git.ts'
import { agentLocation, runWorktreeDirectory } from './naming.ts'

export type WorktreeResult<T> =
	| { readonly kind: 'ok'; readonly value: T }
	| { readonly kind: 'failed'; readonly message: string }

/** A worktree Loom created for one agent of one run. */
export interface WorktreeRef {
	readonly runId: string
	readonly agentId: string
	readonly branch: string
	readonly path: string
}

export interface CreatedWorktree extends WorktreeRef {
	/** The commit the worktree was branched from. */
	readonly baseSha: string
}

/** One entry of `git worktree list`. */
export interface WorktreeEntry {
	readonly path: string
	readonly branch: string | null
}

export interface WorktreeManagerDependencies {
	readonly git: GitRunner
	readonly fs: FileSystem
}

export interface WorktreeManager {
	/** Resolves a ref (e.g. `HEAD`) to a commit sha. */
	resolveBaseSha(ref: string): WorktreeResult<string>
	/** Creates an isolated worktree on its own branch, based on `baseSha`. */
	create(runId: string, agentId: string, baseSha: string): WorktreeResult<CreatedWorktree>
	/** Commits the worktree's changes; `null` when there is nothing to commit. */
	commit(worktree: WorktreeRef, message: string): WorktreeResult<string | null>
	/** Removes one worktree. Idempotent: an already-removed worktree is not an error. */
	remove(worktree: WorktreeRef): WorktreeResult<null>
	/** Removes every worktree of a run, and optionally its branches. */
	removeRun(runId: string, options: { readonly branches: boolean }): WorktreeResult<readonly string[]>
	/** The worktrees git currently knows about. */
	list(): WorktreeResult<readonly WorktreeEntry[]>
}

// Commits are attributed to Loom rather than to the operator: a headless run
// must not fail on a missing git identity, and every agent commit stays
// attributable to the agent that produced it.
const COMMIT_IDENTITY = ['-c', 'user.name=Loom', '-c', 'user.email=loom@localhost']

/** Parses `git worktree list --porcelain` into path/branch entries. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = []
	let entryPath: string | null = null
	let branch: string | null = null

	for (const rawLine of porcelain.split('\n')) {
		const line = rawLine.trimEnd()
		if (line.startsWith('worktree ')) {
			entryPath = line.slice('worktree '.length)
			branch = null
			continue
		}
		if (line.startsWith('branch ') && entryPath !== null) {
			branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
			continue
		}
		if (line === '' && entryPath !== null) {
			entries.push({ path: entryPath, branch })
			entryPath = null
			branch = null
		}
	}
	if (entryPath !== null) entries.push({ path: entryPath, branch })
	return entries
}

export function createWorktreeManager(
	dependencies: WorktreeManagerDependencies,
	options: { readonly repoPath: string },
): WorktreeManager {
	const { git, fs } = dependencies
	const { repoPath } = options

	function resolveBaseSha(ref: string): WorktreeResult<string> {
		const resolved = git.run(['rev-parse', ref])
		if (resolved.kind !== 'ok') return { kind: 'failed', message: resolved.message }
		const sha = resolved.stdout.trim()
		if (sha === '') return { kind: 'failed', message: `git rev-parse ${ref} produced no commit` }
		return { kind: 'ok', value: sha }
	}

	function list(): WorktreeResult<readonly WorktreeEntry[]> {
		const listed = git.run(['worktree', 'list', '--porcelain'])
		if (listed.kind !== 'ok') return { kind: 'failed', message: listed.message }
		return { kind: 'ok', value: parseWorktreeList(listed.stdout) }
	}

	function create(runId: string, agentId: string, baseSha: string): WorktreeResult<CreatedWorktree> {
		const location = agentLocation(repoPath, runId, agentId)

		// Best-effort visibility hygiene; a skip is not a reason to fail a run.
		ensureOrchestrationExcluded(fs, repoPath)

		const added = git.run(['worktree', 'add', '-b', location.branch, location.worktreePath, baseSha])
		if (added.kind !== 'ok') return { kind: 'failed', message: added.message }

		return {
			kind: 'ok',
			value: { runId, agentId, branch: location.branch, path: location.worktreePath, baseSha },
		}
	}

	function commit(worktree: WorktreeRef, message: string): WorktreeResult<string | null> {
		const status = git.run(['-C', worktree.path, 'status', '--porcelain'])
		if (status.kind !== 'ok') return { kind: 'failed', message: status.message }
		if (status.stdout.trim() === '') return { kind: 'ok', value: null }

		const staged = git.run(['-C', worktree.path, 'add', '-A'])
		if (staged.kind !== 'ok') return { kind: 'failed', message: staged.message }

		// The trailers make an agent's commit attributable from `git log` alone.
		const fullMessage = `${message}\n\nLoom-Run: ${worktree.runId}\nLoom-Agent: ${worktree.agentId}`
		const committed = git.run([...COMMIT_IDENTITY, '-C', worktree.path, 'commit', '-m', fullMessage])
		if (committed.kind !== 'ok') return { kind: 'failed', message: committed.message }

		const head = git.run(['-C', worktree.path, 'rev-parse', 'HEAD'])
		if (head.kind !== 'ok') return { kind: 'failed', message: head.message }
		return { kind: 'ok', value: head.stdout.trim() }
	}

	function remove(worktree: WorktreeRef): WorktreeResult<null> {
		if (!fs.isDirectory(worktree.path)) {
			// Already gone: prune the stale registration and report success, so
			// cleanup is safe to run twice.
			git.run(['worktree', 'prune'])
			return { kind: 'ok', value: null }
		}
		const removed = git.run(['worktree', 'remove', '--force', worktree.path])
		if (removed.kind !== 'ok') return { kind: 'failed', message: removed.message }
		return { kind: 'ok', value: null }
	}

	function removeRun(runId: string, removeOptions: { readonly branches: boolean }): WorktreeResult<readonly string[]> {
		const listed = list()
		if (listed.kind !== 'ok') return { kind: 'failed', message: listed.message }

		const prefix = `${runWorktreeDirectory(repoPath, runId)}${path.sep}`
		const removedPaths: string[] = []
		for (const entry of listed.value) {
			if (!entry.path.startsWith(prefix)) continue

			const agentId = path.basename(entry.path)
			const location = agentLocation(repoPath, runId, agentId)
			const removal = remove({ runId, agentId, branch: location.branch, path: entry.path })
			if (removal.kind !== 'ok') return { kind: 'failed', message: removal.message }

			if (removeOptions.branches) {
				const deleted = git.run(['branch', '-D', location.branch])
				if (deleted.kind !== 'ok') return { kind: 'failed', message: deleted.message }
			}
			removedPaths.push(entry.path)
		}

		git.run(['worktree', 'prune'])
		return { kind: 'ok', value: removedPaths }
	}

	return { resolveBaseSha, create, commit, remove, removeRun, list }
}
