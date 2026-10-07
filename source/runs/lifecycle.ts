/**
 * The operations that make a run reversible: inspect, merge, undo, clean.
 *
 * All four are git operations against the base repository, and all four refuse
 * to touch a tree with uncommitted work — an operator's unfinished edit is never
 * something Loom may discard to get its own job done.
 */

import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import type { RunStore } from './store.ts'
import type { GitRunner } from '../workspace/git.ts'
import type { WorktreeManager } from '../workspace/worktree.ts'

/**
 * The three run operations a caller wants by name rather than by sha.
 *
 * The CLI and the HTTP API both need them, and both need the same refusals —
 * an agent that produced no commit, a run that does not exist — so the checks
 * live here once rather than being re-derived per transport.
 */

/** The diff of a run's committed agent branches. All of them, or the one named. */
export function diffRun(
	store: RunStore,
	lifecycle: RunLifecycle,
	runId: string,
	agentId: string | null,
): OpResult<string> {
	const manifest = store.readManifest(runId)
	if (manifest === null) return failed(`no run "${runId}"`)

	const committed = manifest.agents.filter((agent) => agent.branch !== null && agent.sha !== null)
	const selected = agentId === null ? committed : committed.filter((agent) => agent.agentId === agentId)
	if (selected.length === 0) {
		return failed(`no agent with a commit${agentId === null ? '' : ` named "${agentId}"`}`)
	}

	let output = ''
	for (const agent of selected) {
		const diff = lifecycle.diffBetween(manifest.baseSha, agent.branch ?? '')
		if (diff.kind !== 'ok') return failed(diff.message)
		if (agentId === null) output += `--- ${agent.agentId} (${agent.branch ?? ''}) ---\n`
		output += diff.value
	}
	return ok(output)
}

/** Applies one agent's branch to the base branch. Returns the merge commit's sha. */
export function mergeAgent(
	store: RunStore,
	lifecycle: RunLifecycle,
	runId: string,
	agentId: string,
): OpResult<string> {
	const manifest = store.readManifest(runId)
	if (manifest === null) return failed(`no run "${runId}"`)

	const agent = manifest.agents.find((entry) => entry.agentId === agentId)
	if (agent === undefined) return failed(`no agent "${agentId}" in ${runId}`)
	if (agent.branch === null || agent.sha === null) return failed(`${agentId} produced no commit`)

	return lifecycle.mergeBranch(agent.branch)
}

/** Returns the base branch to the commit the run started from. */
export function undoRun(store: RunStore, lifecycle: RunLifecycle, runId: string): OpResult<string> {
	const manifest = store.readManifest(runId)
	if (manifest === null) return failed(`no run "${runId}"`)

	const undone = lifecycle.undo(manifest.baseSha)
	if (undone.kind !== 'ok') return failed(undone.message)
	return ok(manifest.baseSha)
}

/**
 * Marks runs whose owning process has died while they were still in flight.
 *
 * A manifest saying `running` is only true while the process that wrote it is
 * alive, and nothing else can finish that run. This is the same defect as a run
 * killed by a request, reached through a different door: the request path is
 * handled where the signal arrives, but a process that dies never gets to run
 * anything. Left alone, the UI reports "running" beside a log that stopped
 * hours ago, and the operator is told a thing is happening when nothing is.
 *
 * The owner is asked, rather than assumed. A reader is not the authority on
 * whether a run is in flight — a second UI on the same project is a reader, and
 * an earlier version of this marked a *live* benchmark run interrupted because
 * it took "nothing can be running when I start" for a fact about the world
 * rather than a fact about itself.
 *
 * Written exactly as the killed-run path writes it, so a run that was killed and
 * a run whose process died read the same way afterwards.
 */
/**
 * True unless the operating system says there is no such process.
 *
 * An unreadable answer counts as alive: leaving a live run alone shows a stale
 * status, while marking a live run dead loses work that is still happening.
 */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as { readonly code?: string }).code !== 'ESRCH'
	}
}

export function reconcileInterruptedRuns(
	store: RunStore,
	now: () => number,
	isAlive: (pid: number) => boolean,
): readonly string[] {
	const recovered: string[] = []
	for (const runId of store.listRunIds()) {
		const manifest = store.readManifest(runId)
		if (manifest === null || manifest.status !== 'running') continue

		// Someone is running it. Leave it alone: a slow run is not an abandoned one.
		const owner = store.readOwner(runId)
		if (owner !== null && isAlive(owner.pid)) continue

		store.appendEvent(runId, {
			type: 'error',
			agentId: 'run',
			kind: 'interrupted',
			message: 'the process serving this run exited before it finished',
		})
		store.writeManifest(runId, {
			...manifest,
			status: 'interrupted',
			finishedAt: new Date(now()).toISOString(),
		})
		recovered.push(runId)
	}
	return recovered
}

export interface RunLifecycleDependencies {
	readonly git: GitRunner
	readonly worktrees: WorktreeManager
}

export interface RunLifecycle {
	/** The diff an agent's branch introduced, against the commit the run started from. */
	diffBetween(baseSha: string, branch: string): OpResult<string>
	/** Applies one agent's branch to the base branch, as a merge commit. */
	mergeBranch(branch: string): OpResult<string>
	/** Returns the base branch to the commit the run started from. */
	undo(baseSha: string): OpResult<null>
	/** Removes a run's worktrees, and optionally its branches. */
	clean(runId: string, options: { readonly branches: boolean }): OpResult<readonly string[]>
}

export function createRunLifecycle(
	dependencies: RunLifecycleDependencies,
	options: { readonly repoPath: string },
): RunLifecycle {
	const { git, worktrees } = dependencies
	const { repoPath } = options

	/** Every destructive operation goes through this first. */
	function requireCleanBase(): OpResult<null> {
		const status = git.run(['-C', repoPath, 'status', '--porcelain'])
		if (status.kind !== 'ok') return failed(status.message)
		if (status.stdout.trim() !== '') {
			return failed('the base tree has uncommitted changes; commit or stash them first')
		}
		return ok(null)
	}

	return {
		diffBetween(baseSha: string, branch: string): OpResult<string> {
			const result = git.run(['-C', repoPath, 'diff', baseSha, branch])
			if (result.kind !== 'ok') return failed(result.message)
			return ok(result.stdout)
		},

		mergeBranch(branch: string): OpResult<string> {
			const clean = requireCleanBase()
			if (clean.kind !== 'ok') return failed(clean.message)

			const merged = git.run(['-C', repoPath, 'merge', '--no-ff', '--no-edit', '-m', `Loom: merge ${branch}`, branch])
			if (merged.kind !== 'ok') {
				// A conflicted merge leaves the tree mid-merge: conflict markers in
				// the worktree and unmerged paths in the index. The conflict is
				// reported, but the repository is left exactly as it was found —
				// because every later operation refuses a dirty tree, so one
				// conflict would wedge the base and lock out the `undo` that would
				// tidy up. The integration path already does this; this one did not.
				git.run(['-C', repoPath, 'merge', '--abort'])
				return failed(merged.message)
			}

			const head = git.run(['-C', repoPath, 'rev-parse', 'HEAD'])
			if (head.kind !== 'ok') return failed(head.message)
			return ok(head.stdout.trim())
		},

		undo(baseSha: string): OpResult<null> {
			const clean = requireCleanBase()
			if (clean.kind !== 'ok') return failed(clean.message)

			const reset = git.run(['-C', repoPath, 'reset', '--hard', baseSha])
			if (reset.kind !== 'ok') return failed(reset.message)
			return ok(null)
		},

		clean(runId: string, cleanOptions: { readonly branches: boolean }): OpResult<readonly string[]> {
			return worktrees.removeRun(runId, cleanOptions)
		},
	}
}
