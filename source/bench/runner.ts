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
import type { JudgeRequest } from './judge.ts'
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
	/** Null when the suite configures no judge. */
	readonly judge: ((request: JudgeRequest) => Promise<OpResult<number>>) | null
	readonly now: () => number
	/** Progress, one line per completed run. */
	readonly onOutcome?: (outcome: BenchmarkOutcome) => void
}

export interface SuiteRunOptions {
	readonly split: Split
	readonly blueprintPath: string
	readonly deploymentPath: string
	readonly repetitions: number
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
		return outcome(spec.id, repetition, 'error', 0, [created.message], null, 0, elapsedSeconds(dependencies, startedAt))
	}

	const workspace = created.value
	try {
		const run = await dependencies.runTask({
			workspace,
			blueprintPath: options.blueprintPath,
			deploymentPath: options.deploymentPath,
			task: spec.task,
		})
		const wallTimeSeconds = elapsedSeconds(dependencies, startedAt)

		if (run.status !== 'success') {
			return outcome(spec.id, repetition, 'error', 0, [`the run finished ${run.status}`], run.runId, run.costUsd, wallTimeSeconds)
		}

		// Before the validation, not after: a workspace the run did not produce is
		// not evidence of anything, so reading it would be worse than useless.
		if (run.reasons.length > 0) {
			return outcome(spec.id, repetition, 'error', 0, run.reasons, run.runId, run.costUsd, wallTimeSeconds)
		}

		const observation = dependencies.runValidation(workspace, spec.validation)
		const evaluated = evaluateValidation(spec.validation, observation)

		// The command is the contract. A judge grades quality *above* that gate —
		// it may demote work that passes the tests but is poor, and it can never
		// rescue work whose tests fail.
		if (evaluated.status === 'fail') {
			return outcome(spec.id, repetition, 'fail', 0, evaluated.reasons, run.runId, run.costUsd, wallTimeSeconds)
		}

		if (spec.judge !== undefined && dependencies.judge !== null) {
			const judged = await dependencies.judge({
				task: spec.task,
				rubric: spec.judge.rubric,
				evidence: describeEvidence(spec, observation, evaluated.reasons),
			})
			if (judged.kind === 'ok') {
				return outcome(
					spec.id,
					repetition,
					judged.value > 0 ? 'pass' : 'fail',
					judged.value,
					[],
					run.runId,
					run.costUsd,
					wallTimeSeconds,
				)
			}
			// A judge that cannot be reached must not silently zero a passing run.
			return outcome(
				spec.id,
				repetition,
				'pass',
				1,
				[`the judge could not score this run: ${judged.message}`],
				run.runId,
				run.costUsd,
				wallTimeSeconds,
			)
		}

		return outcome(spec.id, repetition, 'pass', 1, [], run.runId, run.costUsd, wallTimeSeconds)
	} finally {
		// Teardown runs on every path, including a thrown error: a leaked
		// workspace is a bug, and a suite run creates one per repetition.
		dependencies.sandbox.remove(workspace)
	}
}

function outcome(
	benchmark: string,
	repetition: number,
	status: BenchmarkOutcome['status'],
	score: number,
	reasons: readonly string[],
	runId: string | null,
	costUsd: number,
	wallTimeSeconds: number,
): BenchmarkOutcome {
	return { benchmark, repetition, status, score, reasons, runId, costUsd, wallTimeSeconds }
}

function elapsedSeconds(dependencies: SuiteRunnerDependencies, startedAt: number): number {
	return (dependencies.now() - startedAt) / 1000
}

function describeEvidence(spec: BenchmarkSpec, observation: ValidationObservation, reasons: readonly string[]): string {
	return [
		`command: ${spec.validation.command}`,
		`exit code: ${observation.exitCode === null ? 'none' : String(observation.exitCode)}`,
		`stdout:\n${observation.stdout}`,
		`checks that failed:\n${reasons.join('\n')}`,
	].join('\n\n')
}
