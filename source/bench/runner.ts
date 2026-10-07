/**
 * Running a suite.
 *
 * For each benchmark, `repetitions` times: build an isolated copy, run the task
 * against it, grade the finished workspace, tear the copy down. The task runner
 * is injected, so the whole orchestration — isolation, teardown on every exit
 * path, aggregation — is exercised in memory without a model or a repository.
 *
 * A run that cannot even start is an `error`, not a `fail`: the distinction
 * matters, because a broken harness should not look like a failing candidate.
 */

import * as path from 'node:path'
import type { ResultStatus } from '../agent/types.ts'
import type { OpResult } from '../result.ts'
import type { LoadedSuite } from './load.ts'
import { selectSplit } from './load.ts'
import { aggregate, summarize } from './score.ts'
import type { BenchmarkSandbox } from './sandbox.ts'
import type { BenchmarkOutcome, BenchmarkSpec, SuiteResult, Split, ValidationSpec } from './types.ts'
import { evaluateValidation, type ValidationObservation } from './validation.ts'

export interface BenchmarkTaskRun {
	readonly status: ResultStatus
	readonly runId: string
	readonly costUsd: number
	/**
	 * Anything that makes the workspace **not the system's output** — a merge that
	 * did not land, a base tree left dirty by a write that escaped a worktree.
	 *
	 * A run with any of these cannot be scored: the validation would be reading a
	 * tree the run did not produce, and a benchmark that credits work the merge
	 * path never carried is measuring nothing.
	 */
	readonly reasons: readonly string[]
}

export type BenchmarkTaskRunner = (options: {
	readonly workspace: string
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly task: string
}) => Promise<BenchmarkTaskRun>

export interface SuiteRunnerDependencies {
	readonly sandbox: BenchmarkSandbox
	readonly runTask: BenchmarkTaskRunner
	readonly runValidation: (workspaceRoot: string, spec: ValidationSpec) => ValidationObservation
	readonly now: () => number
	/** Progress, one line per completed run. */
	readonly onOutcome?: (outcome: BenchmarkOutcome) => void
}

export interface SuiteRunOptions {
	readonly split: Split
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly repetitions: number
	/** Keep each benchmark's sandbox instead of deleting it, so its run stays openable. */
	readonly keepWorkspaces: boolean
}

export async function runSuite(
	dependencies: SuiteRunnerDependencies,
	suite: LoadedSuite,
	options: SuiteRunOptions,
): Promise<SuiteResult> {
	const names = selectSplit(suite, options.split)
	const startedAt = dependencies.now()
	const outcomes: BenchmarkOutcome[] = []

	for (const name of names) {
		const spec = suite.benchmarks[name]
		if (spec === undefined) continue

		const workspaceSource = path.join(suite.suitePath, name, 'workspace')
		for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
			const outcome = await runOnce(dependencies, options, spec, workspaceSource, repetition)
			outcomes.push(outcome)
			dependencies.onOutcome?.(outcome)
		}
	}

	const totals = aggregate(outcomes)
	return {
		suitePath: suite.suitePath,
		blueprintPath: options.blueprintPath,
		split: options.split,
		repetitions: options.repetitions,
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(dependencies.now()).toISOString(),
		benchmarks: summarize(outcomes, names, options.split),
		outcomes,
		score: totals.score,
		interval: totals.interval,
		costUsd: totals.costUsd,
		wallTimeSeconds: totals.wallTimeSeconds,
	}
}

async function runOnce(
	dependencies: SuiteRunnerDependencies,
	options: SuiteRunOptions,
	spec: BenchmarkSpec,
	workspaceSource: string,
	repetition: number,
): Promise<BenchmarkOutcome> {
	const startedAt = dependencies.now()
	const created = dependencies.sandbox.create(workspaceSource)

	if (created.kind !== 'ok') {
		return outcome({
			benchmark: spec.id,
			repetition,
			status: 'error',
			score: 0,
			reasons: [created.message],
			runId: null,
			workspace: null,
			costUsd: 0,
			wallTimeSeconds: elapsedSeconds(dependencies, startedAt),
		})
	}

	const workspace = created.value
	// Kept for the same reason the run's record is: a suite that discards its
	// workspaces leaves nothing to look at when a benchmark fails for a reason
	// nobody can see from the outcome line.
	const kept = options.keepWorkspaces ? workspace : null
	try {
		const run = await dependencies.runTask({
			workspace,
			blueprintPath: options.blueprintPath,
			deploymentPath: options.deploymentPath,
			task: spec.task,
		})
		const wallTimeSeconds = elapsedSeconds(dependencies, startedAt)

		if (run.status !== 'success') {
			return outcome({
				benchmark: spec.id,
				repetition,
				status: 'error',
				score: 0,
				reasons: [`the run finished ${run.status}`],
				runId: run.runId,
				workspace: kept,
				costUsd: run.costUsd,
				wallTimeSeconds,
			})
		}

		// Before the validation, not after: a workspace the run did not produce is
		// not evidence of anything, so reading it would be worse than useless.
		if (run.reasons.length > 0) {
			return outcome({
				benchmark: spec.id,
				repetition,
				status: 'error',
				score: 0,
				reasons: run.reasons,
				runId: run.runId,
				workspace: kept,
				costUsd: run.costUsd,
				wallTimeSeconds,
			})
		}

		const observation = dependencies.runValidation(workspace, spec.validation)
		const evaluated = evaluateValidation(spec.validation, observation)

		// The command is the contract. There is no layer above it: a run whose
		// checks fail is a failure, and a run whose checks pass is a pass.
		if (evaluated.status === 'fail') {
			return outcome({
				benchmark: spec.id,
				repetition,
				status: 'fail',
				score: 0,
				reasons: evaluated.reasons,
				runId: run.runId,
				workspace: kept,
				costUsd: run.costUsd,
				wallTimeSeconds,
			})
		}

		return outcome({
				benchmark: spec.id,
				repetition,
				status: 'pass',
				score: 1,
				reasons: [],
				runId: run.runId,
				workspace: kept,
				costUsd: run.costUsd,
				wallTimeSeconds,
			})
	} finally {
		// Teardown runs on every path, including a thrown error: a leaked
		// workspace is a bug, and a suite run creates one per repetition — unless
		// the caller asked to keep them, which is the only way to inspect a run
		// whose outcome line does not explain itself.
		if (!options.keepWorkspaces) dependencies.sandbox.remove(workspace)
	}
}

function outcome(fields: BenchmarkOutcome): BenchmarkOutcome {
	return fields
}

function elapsedSeconds(dependencies: SuiteRunnerDependencies, startedAt: number): number {
	return (dependencies.now() - startedAt) / 1000
}

