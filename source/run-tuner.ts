/**
 * The composition root for an optimization run.
 *
 * It wires the real evaluator (the Bench), the real big model, and the real
 * filesystem — and nothing else does, so the loop above it stays exercisable in
 * memory.
 */

import * as path from 'node:path'
import { ValidationError } from './errors.ts'
import { createDirectoryRemover } from './directory-remover.ts'
import { createProviderRegistry } from './deployment/registry.ts'
import { loadDeployment } from './deployment/load.ts'
import type { FetchLike } from './model/openai.ts'
import { createNodeFileSystem } from './node-fs.ts'
import { runBench } from './run-bench.ts'
import { BLUEPRINT_FILE, createBranchManager } from './tuner/branch.ts'
import { parseTunerConfig } from './tuner/config.ts'
import { runTuner } from './tuner/loop.ts'
import { createChangeMerger, createHypothesisProposer } from './tuner/model.ts'
import { createPromoter } from './tuner/promote.ts'
import { writeReport } from './tuner/report.ts'
import type { TunerConfig, TunerReport } from './tuner/types.ts'

export interface RunTunerOptions {
	readonly configPath: string
	readonly repoPath: string
	readonly env: Readonly<Record<string, string | undefined>>
	readonly fetch: FetchLike
	readonly onEvent?: (message: string) => void
}

/** The config's own paths are relative to the config file, like the Blueprint's are. */
function resolvePaths(config: TunerConfig, base: string): TunerConfig {
	return {
		...config,
		suitePath: path.resolve(base, config.suitePath),
		guildPath: path.resolve(base, config.guildPath),
		deploymentPath: path.resolve(base, config.deploymentPath),
	}
}

export async function runTunerCommand(options: RunTunerOptions): Promise<TunerReport> {
	const fs = createNodeFileSystem()

	const read = fs.readTextFile(options.configPath)
	if (read.kind !== 'ok') throw new ValidationError(options.configPath, read.message)

	let parsed: unknown
	try {
		parsed = JSON.parse(read.text)
	} catch (error) {
		throw new ValidationError(options.configPath, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
	}
	const config = resolvePaths(parseTunerConfig(parsed, options.configPath), path.dirname(options.configPath))

	const deployment = loadDeployment({ readTextFile: fs.readTextFile }, config.deploymentPath)
	const providers = createProviderRegistry({ fetch: options.fetch, env: options.env }, deployment)

	const big = providers.create(config.bigModel.provider)
	if (big.kind !== 'ok') throw new Error(`the big model cannot be built: ${big.message}`)

	const workspacePath = path.join(options.repoPath, '.loom', 'tuner')
	const branch = createBranchManager({ fs, removeDirectory: createDirectoryRemover() }, { workspacePath })
	const promoter = createPromoter({ fs, now: () => Date.now() }, { guildPath: config.guildPath, workspacePath })

	const report = await runTuner(
		{
			fs,
			branch,
			promoter,
			evaluate: (guildPath, split) =>
				runBench({
					suitePath: config.suitePath,
					split,
					blueprintPath: path.join(guildPath, BLUEPRINT_FILE),
					deploymentPath: config.deploymentPath,
					repetitions: config.repetitions,
					// The Tuner's own bookkeeping is the report; per-run bench results
					// would bury it.
					resultsDirectory: null,
					env: options.env,
					fetch: options.fetch,
				}),
			propose: createHypothesisProposer({ provider: big.value, model: config.bigModel.model }),
			// The price table is the only list of models the deployment knows about,
			// and the proposer needs it to propose a cheaper route.
			pricedModels: Object.entries(deployment.prices).map(
				([name, price]) => `${name} — $${String(price.inputPer1M)} in / $${String(price.outputPer1M)} out per 1M`,
			),
			merge: createChangeMerger({ provider: big.value, model: config.bigModel.model }),
			now: () => Date.now(),
			...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
		},
		config,
	)

	writeReport({ fs }, workspacePath, report)
	return report
}
