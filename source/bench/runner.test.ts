import { describe, expect, test } from 'bun:test'
import type { OpResult } from '../result.ts'
import { ok } from '../result.ts'
import { createCounterClock } from '../test-support/clock.ts'
import type { JudgeRequest } from './judge.ts'
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
		judge: { rubric: 'Does the work address the task?' },
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
	readonly judge?: ((request: JudgeRequest) => Promise<OpResult<number>>) | null
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
			return { status: 'success', runId: 'run-1', costUsd: 0.01 }
		},
		runValidation: () => options.observation ?? PASSING,
		judge: options.judge ?? null,
		now: createCounterClock(1_700_000_000_000),
	}

	return {
		dependencies,
		created,
		removed,
		tasks,
		run: (split: Split, repetitions = 1) =>
			runSuite(dependencies, suite, {
				split,
				blueprintPath: '/bp.json',
				deploymentPath: '/dep.json',
				repetitions,
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
		await harness.run('optimization', 2)

		expect(harness.created).toHaveLength(4)
		expect(harness.removed).toEqual(['/tmp/bench-1', '/tmp/bench-2', '/tmp/bench-3', '/tmp/bench-4'])
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
		const harness = createHarness({ task: async () => ({ status: 'error', runId: 'run-9', costUsd: 0.02 }) })
		const result = await harness.run('optimization')

		expect(result.outcomes.every((outcome) => outcome.status === 'error')).toBe(true)
		expect(result.outcomes[0]?.reasons).toEqual(['the run finished error'])
		expect(result.outcomes[0]?.runId).toBe('run-9')
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

	test('a judge grades quality above the deterministic gate', async () => {
		const harness = createHarness({ judge: async () => ok(0.5) })
		const result = await harness.run('optimization')

		expect(result.outcomes[0]?.status).toBe('pass')
		expect(result.outcomes[0]?.score).toBeCloseTo(0.5, 10)
	})

	test('a judge never rescues a run whose command failed', async () => {
		const harness = createHarness({ observation: FAILING, judge: async () => ok(1) })
		const outcome = (await harness.run('optimization')).outcomes[0]

		expect(outcome?.status).toBe('fail')
		expect(outcome?.score).toBe(0)
		expect(outcome?.reasons).toEqual(['expected exit code 0, got 1'])
	})

	test('a judge scoring zero demotes a passing run', async () => {
		const harness = createHarness({ judge: async () => ok(0) })
		expect((await harness.run('optimization')).outcomes[0]?.status).toBe('fail')
	})

	test('a judge that errors does not zero a passing run', async () => {
		const harness = createHarness({ judge: async () => ({ kind: 'failed', message: 'judge down' }) })
		const outcome = (await harness.run('optimization')).outcomes[0]

		expect(outcome?.status).toBe('pass')
		expect(outcome?.score).toBe(1)
		expect(outcome?.reasons).toContain('the judge could not score this run: judge down')
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
