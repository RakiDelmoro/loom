/**
 * `loom serve` — the HTTP API and the browser UI.
 *
 * The server is a thin shell over the same operations the CLI runs, sharing one
 * repository handle so the worktree manager and the run store see a single
 * project. It does not supervise itself: a run that throws is reported and the
 * server keeps serving, because the operator is looking at it.
 */

import { loadDeployment } from './deployment/load.ts'
import type { FileSystem } from './fs.ts'
import { createRunStore } from './runs/store.ts'
import { createRunLifecycle, processIsAlive, reconcileInterruptedRuns } from './runs/lifecycle.ts'
import { runTask, generateRunId } from './run-task.ts'
import * as path from 'node:path'
import { runBench } from './run-bench.ts'
import type { BenchmarkOutcome } from './bench/types.ts'
import { createRunService } from './server/service.ts'
import { startServer, defaultStaticRoot } from './server/server.ts'
import { noRedaction } from './redact.ts'
import { createWorktreeManager } from './workspace/worktree.ts'
import { createGitRunner } from './workspace/git.ts'
import type { AutonomyLevel } from './runs/types.ts'

export interface ServeOptions {
	readonly repoPath: string
	/** The benchmark suite directory the /api/bench endpoint runs. */
	readonly suitePath: string
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly hostname: string
	readonly port: number
	readonly token: string | null
	readonly autonomy: AutonomyLevel
	readonly fs: FileSystem
	readonly env: Readonly<Record<string, string | undefined>>
	readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
	readonly write: (message: string) => void
}

export interface ServeHandle {
	readonly url: string
	stop(): Promise<void>
}

export async function serve(options: ServeOptions): Promise<ServeHandle> {
	const git = createGitRunner({ cwd: options.repoPath })
	const worktrees = createWorktreeManager({ git, fs: options.fs }, { repoPath: options.repoPath })
	const store = createRunStore({ fs: options.fs, now: () => Date.now(), redact: noRedaction }, { repoPath: options.repoPath })
	const lifecycle = createRunLifecycle({ git, worktrees }, { repoPath: options.repoPath })

	// Read once, for the price table the trace needs. A run re-reads its own copy.
	const deployment = loadDeployment({ readTextFile: options.fs.readTextFile }, options.deploymentPath)

	// A run still marked `running` whose owner is gone is one nothing can finish.
	// Say so before serving, or the UI reports a run that is happening when it
	// stopped hours ago — but ask the owner first: another process may be running
	// it, and this one is a reader.
	for (const runId of reconcileInterruptedRuns(store, () => Date.now(), processIsAlive)) {
		options.write(`run ${runId} was left running by a process that has exited; marked interrupted\n`)
	}

	const service = createRunService({
		store,
		lifecycle,
		// For a run that happened in another repository: the port forwards to it,
		// so a viewer can show the diff without being the repository the run used.
		lifecycleFor: (repoPath) => {
			const gitForRun = createGitRunner({ cwd: repoPath })
			return createRunLifecycle(
				{ git: gitForRun, worktrees: createWorktreeManager({ git: gitForRun, fs: options.fs }, { repoPath }) },
				{ repoPath },
			)
		},
		startRun: (runOptions) => runTask(runOptions),
		newRunId: () => generateRunId(new Date()),
		repoPath: options.repoPath,
		blueprintPath: options.blueprintPath,
		deploymentPath: options.deploymentPath,
		env: options.env,
		fetch: options.fetch,
		reportFailure: (message) => {
			options.write(`a run failed: ${message}\n`)
		},
	})

	// The suite runner the /api/bench endpoint drives. One at a time: two suites
	// would race on the model endpoint's single slot and on the results file.
	let benchRunning = false
	let benchLast: unknown = null
	const benchDefaults = {
		suitePath: options.suitePath,
		blueprintPath: options.blueprintPath,
		deploymentPath: options.deploymentPath,
		repetitions: 1,
		keepWorkspaces: true,
		resultsDirectory: path.join(options.repoPath, '.loom', 'bench'),
		env: options.env,
		fetch: options.fetch,
		onOutcome: (outcome: BenchmarkOutcome) => options.write(`bench: ${outcome.benchmark} #${String(outcome.repetition)} ${outcome.status}\n`),
	}
	const startBench = (split: string): { readonly kind: 'ok' } | { readonly kind: 'failed'; readonly message: string } => {
		if (benchRunning) return { kind: 'failed', message: 'a suite run is already in progress' }
		if (split !== 'held-out' && split !== 'optimization') return { kind: 'failed', message: 'split must be "held-out" or "optimization"' }
		benchRunning = true
		void runBench({ ...benchDefaults, split })
			.then((result) => {
				benchLast = result
				options.write(`bench: score ${(result.score * 100).toFixed(1)}% (${String(result.outcomes.length)} benchmarks)\n`)
			})
			.catch((error: unknown) => options.write(`bench failed: ${error instanceof Error ? error.message : String(error)}\n`))
			.finally(() => {
				benchRunning = false
			})
		return { kind: 'ok' }
	}
	const benchStatus = () => ({ running: benchRunning, last: benchLast })

	const server = await startServer(
		{
			routes: { service, prices: deployment.prices, defaultAutonomy: options.autonomy, startBench, benchStatus },
			fs: options.fs,
			staticRoot: defaultStaticRoot(),
			token: options.token,
			log: options.write,
		},
		{ port: options.port, hostname: options.hostname },
	)

	options.write(`loom serving ${options.repoPath}\n`)
	options.write(`  ${server.url}\n`)
	options.write(
		options.token === null
			? '  no token: any local caller may drive it\n'
			: '  a bearer token is required for every /api/ call\n',
	)

	return {
		url: server.url,
		stop: async (): Promise<void> => {
			// The run first: stopping the server would otherwise leave an in-flight
			// run's manifest saying `running` with nothing left to finish it.
			service.stop()
			await server.stop()
		},
	}
}
