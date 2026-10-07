/**
 * The composition root for one run.
 *
 * Every real dependency is assembled here — the filesystem, git, the model
 * client, the tools, the store — and handed to the modules that were written to
 * receive theirs. This is the only place in the project that does so, which is
 * what keeps everything else testable without a repository or a network.
 */

import { randomUUID } from 'node:crypto'
import type { ResultStatus } from './agent/types.ts'
import { loadBlueprint } from './blueprint/load.ts'
import { createOpenAiCompatibleProvider } from './model/openai.ts'
import { createNodeFileSystem } from './node-fs.ts'
import type { RunEventSink } from './runs/events.ts'
import { createRunLifecycle } from './runs/lifecycle.ts'
import { createRunRecorder } from './runs/recorder.ts'
import { createRunStore } from './runs/store.ts'
import type { AutonomyLevel, RunManifest } from './runs/types.ts'
import { agentBranches } from './runs/types.ts'
import { createScheduler } from './scheduler/run.ts'
import { createGitToolHandlers } from './tools/git.ts'
import { createToolRegistry } from './tools/registry.ts'
import { createRunCommand } from './tools/run-command.ts'
import { createShellToolHandlers } from './tools/shell.ts'
import { createWorkspaceToolHandlers } from './tools/workspace.ts'
import { createGitRunner } from './workspace/git.ts'
import { createWorktreeManager } from './workspace/worktree.ts'

export interface RunTaskOptions {
	readonly repoPath: string
	readonly blueprintPath: string
	readonly task: string
	readonly autonomy: AutonomyLevel
	readonly apiBase: string
	readonly apiKey?: string
	/** Observed as the run progresses, for live output. */
	readonly events?: RunEventSink
}

export interface MergedBranch {
	readonly branch: string
	readonly sha: string
}

export interface MergeFailure {
	readonly branch: string
	readonly message: string
}

export interface RunOutcome {
	readonly manifest: RunManifest
	readonly status: ResultStatus
	readonly merged: readonly MergedBranch[]
	readonly mergeFailures: readonly MergeFailure[]
}

/** `run-20261007T142233Z-a1b2c3` — sortable, and unique enough for a local tool. */
export function generateRunId(now: Date): string {
	const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
	return `run-${stamp}-${randomUUID().slice(0, 6)}`
}

export async function runTask(options: RunTaskOptions): Promise<RunOutcome> {
	const fs = createNodeFileSystem()
	const blueprint = loadBlueprint({ readTextFile: fs.readTextFile }, options.blueprintPath)

	const git = createGitRunner({ cwd: options.repoPath })
	const worktrees = createWorktreeManager({ git, fs }, { repoPath: options.repoPath })

	// The base is pinned before anything else, so every agent branches from the
	// same commit even if the repository moves during the run.
	const base = worktrees.resolveBaseSha('HEAD')
	if (base.kind !== 'ok') throw new Error(base.message)

	const runId = generateRunId(new Date())
	const store = createRunStore({ fs, now: () => Date.now() }, { repoPath: options.repoPath })
	const recorder = createRunRecorder(
		{ store, now: () => Date.now() },
		{ runId, task: options.task, baseRef: 'HEAD', baseSha: base.value, autonomy: options.autonomy },
	)
	recorder.begin()

	const provider = createOpenAiCompatibleProvider({
		id: 'loom',
		baseUrl: options.apiBase,
		...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
		fetch: (url, init) => fetch(url, init),
	})

	const tools = createToolRegistry([
		...createWorkspaceToolHandlers({ fs }),
		...createShellToolHandlers({
			runCommand: createRunCommand(),
			defaultTimeoutSeconds: blueprint.budgets.toolTimeoutSeconds,
		}),
		...createGitToolHandlers({ git }),
	])

	const events: RunEventSink = (event) => {
		recorder.events(event)
		options.events?.(event)
	}

	const scheduler = createScheduler(
		{ provider, tools, worktrees, blueprint, now: () => Date.now(), events },
		{ repoPath: options.repoPath },
	)

	const result = await scheduler.run({ runId, task: options.task })
	const manifest = recorder.finish(result)

	const merged: MergedBranch[] = []
	const mergeFailures: MergeFailure[] = []

	if (options.autonomy === 'auto' && result.card.status === 'success') {
		const lifecycle = createRunLifecycle({ git, worktrees }, { repoPath: options.repoPath })
		for (const branch of agentBranches(manifest)) {
			const merge = lifecycle.mergeBranch(branch)
			if (merge.kind === 'ok') {
				merged.push({ branch, sha: merge.value })
				continue
			}
			// Stop at the first conflict: merging the rest would build on a base
			// that is not what the remaining branches were written against.
			mergeFailures.push({ branch, message: merge.message })
			break
		}
	}

	return { manifest, status: result.card.status, merged, mergeFailures }
}
