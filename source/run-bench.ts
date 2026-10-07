/**
 * The composition root for a suite run.
 *
 * It wires the real sandbox, task runner, validation, and judge, and nothing
 * else does — so the runner above it stays exercisable in memory.
 */

import * as path from 'node:path'
import { createBenchmarkSandbox } from './bench/sandbox.ts'
import { judgeWork, type JudgeRequest } from './bench/judge.ts'
import { loadSuite } from './bench/load.ts'
import { runSuite } from './bench/runner.ts'
import type { BenchmarkOutcome, Split, SuiteResult } from './bench/types.ts'
import { runValidation } from './bench/validation.ts'
import { createProviderRegistry } from './deployment/registry.ts'
import { loadDeployment } from './deployment/load.ts'
import type { FetchLike } from './model/openai.ts'
import { createNodeFileSystem } from './node-fs.ts'
import type { OpResult } from './result.ts'
import { runTask, generateRunId } from './run-task.ts'
import { createRunControl } from './runs/control.ts'
import { createRunCommand } from './tools/run-command.ts'
import { createGitRunner } from './workspace/git.ts'

export interface RunBenchOptions {
	readonly suitePath: string
	readonly split: Split
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly repetitions: number
	/** Where to append the result, for regression tracking. Null writes nothing. */
	readonly resultsDirectory: string | null
	readonly env: Readonly<Record<string, string | undefined>>
	readonly fetch: FetchLike
	readonly onOutcome?: (outcome: BenchmarkOutcome) => void
}

export async function runBench(options: RunBenchOptions): Promise<SuiteResult> {
	const fs = createNodeFileSystem()
	const suite = loadSuite({ fs }, options.suitePath)
	const deployment = loadDeployment({ readTextFile: fs.readTextFile }, options.deploymentPath)

	const providers = createProviderRegistry({ fetch: options.fetch, env: options.env }, deployment)

	let judge: ((request: JudgeRequest) => Promise<OpResult<number>>) | null = null
	const judgeConfig = suite.config.judge
	if (judgeConfig !== undefined) {
		const created = providers.create(judgeConfig.provider)
		if (created.kind !== 'ok') throw new Error(`the judge cannot be built: ${created.message}`)
		const judgeProvider = created.value
		judge = (request) => judgeWork({ provider: judgeProvider, model: judgeConfig.model }, request)
	}

	const runCommand = createRunCommand()
	const result = await runSuite(
		{
			sandbox: createBenchmarkSandbox({ gitFor: (cwd) => createGitRunner({ cwd }) }),
			runTask: async (request) => {
				// `auto` autonomy, so the agents' branches are merged and the
				// validation sees the system's real output — merge included.
				const outcome = await runTask({
					runId: generateRunId(new Date()),
					control: createRunControl(),
					repoPath: request.workspace,
					blueprintPath: request.blueprintPath,
					deploymentPath: request.deploymentPath,
					task: request.task,
					autonomy: 'auto',
					modelOverrides: {},
					// A benchmark run is unattended by definition, so it approves nothing.
					approvals: [],
					env: options.env,
					fetch: options.fetch,
				})
				return { status: outcome.status, runId: outcome.manifest.runId, costUsd: outcome.manifest.costUsd }
			},
			runValidation: (workspaceRoot, spec) => runValidation({ fs, runCommand }, workspaceRoot, spec),
			judge,
			now: () => Date.now(),
			...(options.onOutcome !== undefined ? { onOutcome: options.onOutcome } : {}),
		},
		suite,
		{
			split: options.split,
			blueprintPath: options.blueprintPath,
			deploymentPath: options.deploymentPath,
			repetitions: options.repetitions,
		},
	)

	if (options.resultsDirectory !== null) {
		const stamp = result.finishedAt.replace(/[:.]/g, '-')
		fs.ensureDirectory(options.resultsDirectory)
		fs.writeTextFile(path.join(options.resultsDirectory, `${stamp}.json`), `${JSON.stringify(result, null, '\t')}\n`)
	}

	return result
}
