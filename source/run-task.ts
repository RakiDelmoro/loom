/**
 * The composition root for one run.
 *
 * Every real dependency is assembled here — the filesystem, git, the provider
 * registry, the tools, the store — and handed to the modules that were written
 * to receive theirs. This is the only place in the project that does so, which
 * is what keeps everything else testable without a repository or a network.
 */

import { randomUUID } from 'node:crypto'
import type { ResultStatus } from './agent/types.ts'
import { loadBlueprint } from './blueprint/load.ts'
import type { LoadedBlueprint } from './blueprint/types.ts'
import { loadDeployment } from './deployment/load.ts'
import { collectSecrets } from './deployment/secrets.ts'
import { createRedactor } from './redact.ts'
import { createProviderRegistry, type ProviderRegistry } from './deployment/registry.ts'
import type { Deployment } from './deployment/types.ts'
import type { FetchLike } from './model/openai.ts'
import { validateOverrides } from './model/router.ts'
import { createNodeFileSystem } from './node-fs.ts'
import type { RunControl } from './runs/control.ts'
import type { RunEventSink } from './runs/events.ts'
import { createRunLifecycle } from './runs/lifecycle.ts'
import { createRunRecorder } from './runs/recorder.ts'
import { createRunStore } from './runs/store.ts'
import type { AutonomyLevel, RunManifest } from './runs/types.ts'
import { acceptedBranches } from './runs/types.ts'
import { createScheduler } from './scheduler/run.ts'
import { createGitToolHandlers } from './tools/git.ts'
import { createFetchToolHandlers } from './tools/fetch-url.ts'
import { createToolRegistry } from './tools/registry.ts'
import { createRunCommand } from './tools/run-command.ts'
import { createShellToolHandlers } from './tools/shell.ts'
import { createWorkspaceToolHandlers } from './tools/workspace.ts'
import { createGitRunner } from './workspace/git.ts'
import { createWorktreeManager } from './workspace/worktree.ts'

export interface RunTaskOptions {
	/** Chosen by the caller, so a service can name the run before it starts. */
	readonly runId: string
	/** The operator's channel into this run. */
	readonly control: RunControl
	readonly repoPath: string
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly task: string
	readonly autonomy: AutonomyLevel
	/** Role → profile, overriding the Blueprint for this run only. */
	readonly modelOverrides: Readonly<Record<string, string>>
	/** Tools this run has been granted approval for. */
	readonly approvals: readonly string[]
	readonly env: Readonly<Record<string, string | undefined>>
	readonly fetch: FetchLike
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

/**
 * Refuses to start a run whose Blueprint names a provider or a model the
 * deployment file does not cover. Both omissions would otherwise surface as a
 * confusing failure deep into a run — or, worse for pricing, as a silently
 * zero-cost run.
 */
export function requireDeploymentCovers(blueprint: LoadedBlueprint, deployment: Deployment): void {
	const providers = createProviderRegistry({ fetch: async () => new Response(), env: {} }, deployment)
	const missingProviders = new Set<string>()
	const missingPrices = new Set<string>()

	for (const profile of Object.values(blueprint.routing)) {
		if (!providers.has(profile.provider)) missingProviders.add(profile.provider)
		if (deployment.prices[profile.model] === undefined) missingPrices.add(profile.model)
	}

	if (missingProviders.size > 0) {
		throw new Error(`the deployment file has no provider named: ${[...missingProviders].sort().join(', ')}`)
	}
	if (missingPrices.size > 0) {
		throw new Error(
			`the deployment file has no price for: ${[...missingPrices].sort().join(', ')} — add a price entry (0 is valid) so a run's cost is never silently zero`,
		)
	}
}

export async function runTask(options: RunTaskOptions): Promise<RunOutcome> {
	const fs = createNodeFileSystem()
	const blueprint = loadBlueprint({ readTextFile: fs.readTextFile }, options.blueprintPath)
	const deployment = loadDeployment({ readTextFile: fs.readTextFile }, options.deploymentPath)

	validateOverrides(blueprint, options.modelOverrides)
	requireDeploymentCovers(blueprint, deployment)

	const git = createGitRunner({ cwd: options.repoPath })
	const worktrees = createWorktreeManager({ git, fs }, { repoPath: options.repoPath })

	// The base is pinned before anything else, so every agent branches from the
	// same commit even if the repository moves during the run.
	const base = worktrees.resolveBaseSha('HEAD')
	if (base.kind !== 'ok') throw new Error(base.message)

	const runId = options.runId
	const redact = createRedactor(collectSecrets(deployment, options.env))
	const store = createRunStore({ fs, now: () => Date.now(), redact }, { repoPath: options.repoPath })
	const recorder = createRunRecorder(
		{ store, now: () => Date.now() },
		{ runId, task: options.task, baseRef: 'HEAD', baseSha: base.value, autonomy: options.autonomy },
	)
	recorder.begin()

	const providers: ProviderRegistry = createProviderRegistry(
		{ fetch: options.fetch, env: options.env },
		deployment,
	)

	const tools = createToolRegistry([
		...createWorkspaceToolHandlers({ fs }),
		...createShellToolHandlers({
			runCommand: createRunCommand(),
			defaultTimeoutSeconds: blueprint.budgets.toolTimeoutSeconds,
		}),
		...createGitToolHandlers({ git }),
		// Egress is granted by the Blueprint, never assumed.
		...createFetchToolHandlers({ fetch: options.fetch, allowedHosts: blueprint.permissions.egress }),
	])

	const events: RunEventSink = (event) => {
		recorder.events(event)
		options.events?.(event)
	}

	const scheduler = createScheduler(
		{
			providers,
			tools,
			worktrees,
			blueprint,
			now: () => Date.now(),
			monotonicNow: () => performance.now(),
			sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
			events,
			control: options.control,
		},
		{ repoPath: options.repoPath, prices: deployment.prices, modelOverrides: options.modelOverrides, approvals: options.approvals },
	)

	const result = await scheduler.run({ runId, task: options.task })
	const manifest = recorder.finish(result)

	const merged: MergedBranch[] = []
	const mergeFailures: MergeFailure[] = []

	if (options.autonomy === 'auto' && result.card.status === 'success') {
		const lifecycle = createRunLifecycle({ git, worktrees }, { repoPath: options.repoPath })
		for (const branch of acceptedBranches(manifest)) {
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
