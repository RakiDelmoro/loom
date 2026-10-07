import { describe, expect, test } from 'bun:test'
import type { OpResult } from '../result.ts'
import { ok } from '../result.ts'
import { createCounterClock } from '../test-support/clock.ts'
import type { LoadedSuite } from './load.ts'
import { runSuite, type BenchmarkTaskRun, type SuiteRunnerDependencies } from './runner.ts'
import type { BenchmarkSpec, Split } from './types.ts'
import type { ValidationObservation } from './validation.ts'

function spec(id: string): BenchmarkSpec {
	return {
		id,
		taskType: 'bugfix',
		difficulty: 'easy',
		task: `do ${id}`,
		validation: {
			command: 'bun test',
			expectedExitCode: 0,
			expectedFiles: [],
			expectedStdoutContains: [],
			timeoutSeconds: 30,
		},
	}
}

const suite: LoadedSuite = {
	suitePath: '/suite',
	benchmarks: { a: spec('a'), b: spec('b'), held: spec('held') },
	config: { optimization: ['a', 'b'], heldOut: ['held'] },
}

const PASSING: ValidationObservation = { exitCode: 0, stdout: '', timedOut: false, missingFiles: [], unavailable: null }
const FAILING: ValidationObservation = { exitCode: 1, stdout: 'boom', timedOut: false, missingFiles: [], unavailable: null }

function createHarness(options: {
	readonly task?: (workspace: string, task: string) => Promise<BenchmarkTaskRun>
	readonly observation?: ValidationObservation
} = {}) {
	const created: string[] = []
	const removed: string[] = []
	const tasks: string[] = []
	let counter = 0

	const dependencies: SuiteRunnerDependencies = {
		sandbox: {
			create: (sourceWorkspace) => {
				counter += 1
				created.push(sourceWorkspace)
				return ok(`/tmp/bench-${String(counter)}`)
			},
			remove: (directory) => {
				removed.push(directory)
			},
		},
		runTask: async (request) => {
			tasks.push(request.task)
			if (options.task !== undefined) return options.task(request.workspace, request.task)
			return { status: 'success', runId: 'run-1', costUsd: 0.01, reasons: [] }
		},
		runValidation: () => options.observation ?? PASSING,
		now: createCounterClock(1_700_000_000_000),
	}

	return {
		dependencies,
		created,
		removed,
		tasks,
		run: (split: Split, repetitions = 1, keepWorkspaces = false) =>
			runSuite(dependencies, suite, {
				split,
				blueprintPath: '/bp.json',
				deploymentPath: '/dep.json',
				repetitions: repetitions,
				keepWorkspaces,
			}),
	}
}

describe('runSuite', () => {
	test('runs every benchmark in the split, the requested number of times', async () => {
		const harness = createHarness()
		const result = await harness.run('optimization', 3)

		expect(harness.tasks).toEqual(['do a', 'do a', 'do a', 'do b', 'do b', 'do b'])
		expect(result.outcomes).toHaveLength(6)
		expect(result.repetitions).toBe(3)
	})

	test('never touches the other split', async () => {
		// The structural guarantee: a held-out benchmark is not run, so its result
		// cannot reach whatever consumes this one.
		const harness = createHarness()
		const result = await harness.run('optimization')

		expect(harness.tasks).toEqual(['do a', 'do b'])
		expect(result.outcomes.map((outcome) => outcome.benchmark)).toEqual(['a', 'b'])
		expect(JSON.stringify(result)).not.toContain('do held')
	})

	test('tears down every workspace it created', async () => {
		const harness = createHarness()
		const result = await harness.run('optimization', 2)

		expect(harness.created).toHaveLength(4)
		expect(harness.removed).toEqual(['/tmp/bench-1', '/tmp/bench-2', '/tmp/bench-3', '/tmp/bench-4'])
		// And names none of them: a path to a directory that has been deleted is
		// worse than no path, because it reads as something that can be opened.
		expect(result.outcomes.every((outcome) => outcome.workspace === null)).toBe(true)
	})

	test('keeping the workspaces leaves them in place, and says where they are', async () => {
		// A suite deletes what it built, so a benchmark that fails for a reason its
		// outcome line does not explain leaves nothing to look at. The run's own
		// record lives in the workspace, so the pointer is the thing that makes a
		// finished suite openable.
		const harness = createHarness()
		const result = await harness.run('optimization', 1, true)

		expect(harness.removed).toEqual([])
		expect(result.outcomes.map((outcome) => outcome.workspace)).toEqual(['/tmp/bench-1', '/tmp/bench-2'])
	})

	test('tears down even when the task runner throws', async () => {
		const harness = createHarness({
			task: async () => {
				throw new Error('the runner exploded')
			},
		})

		await expect(harness.run('optimization')).rejects.toThrow('the runner exploded')
		expect(harness.removed).toHaveLength(1)
	})

	test('a run that did not finish is an error, not a fail', async () => {
		const harness = createHarness({ task: async () => ({ status: 'error', runId: 'run-9', costUsd: 0.02, reasons: [] }) })
		const result = await harness.run('optimization')

		expect(result.outcomes.every((outcome) => outcome.status === 'error')).toBe(true)
		expect(result.outcomes[0]?.reasons).toEqual(['the run finished error'])
		expect(result.outcomes[0]?.runId).toBe('run-9')
	})

	test('a run whose work never landed is not scored, even when the tests pass', async () => {
		// The bug this defends against: an agent wrote into the base repository
		// through a shell, escaping its worktree. The tests passed — on a tree the
		// merge path never produced — and the benchmark credited it.
		const harness = createHarness({
			task: async () => ({
				status: 'success',
				runId: 'run-7',
				costUsd: 0.03,
				reasons: ['the run left uncommitted changes in the base repository'],
			}),
			observation: PASSING,
		})
		const result = await harness.run('optimization')

		expect(result.outcomes[0]?.status).toBe('error')
		expect(result.outcomes[0]?.score).toBe(0)
		expect(result.outcomes[0]?.reasons).toEqual(['the run left uncommitted changes in the base repository'])
	})

	test('a validation failure is a fail, carrying its reasons', async () => {
		const harness = createHarness({ observation: FAILING })
		const result = await harness.run('optimization')

		expect(result.outcomes[0]?.status).toBe('fail')
		expect(result.outcomes[0]?.score).toBe(0)
		expect(result.outcomes[0]?.reasons).toEqual(['expected exit code 0, got 1'])
	})

	test('a pass scores 1', async () => {
		const result = await createHarness().run('optimization')
		expect(result.score).toBe(1)
		expect(result.benchmarks.every((summary) => summary.passRate === 1)).toBe(true)
	})





	test('a benchmark whose workspace cannot be built is an error', async () => {
		const harness = createHarness()
		harness.dependencies.sandbox.create = () => ({ kind: 'failed', message: 'no space left' })

		const outcome = (await harness.run('optimization')).outcomes[0]
		expect(outcome?.status).toBe('error')
		expect(outcome?.reasons).toEqual(['no space left'])
	})

	test('the summary totals cost across repetitions', async () => {
		const result = await createHarness().run('optimization', 2)
		expect(result.benchmarks[0]?.costUsd).toBeCloseTo(0.02, 10)
		expect(result.costUsd).toBeCloseTo(0.04, 10)
	})
})
