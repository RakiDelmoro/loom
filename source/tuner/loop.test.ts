import { describe, expect, test } from 'bun:test'
import type { Split, SuiteResult } from '../bench/types.ts'
import type { OpResult } from '../result.ts'
import { ok } from '../result.ts'
import { createMemoryFileSystem, type MemoryFileSystem } from '../test-support/memory-fs.ts'
import { createSuiteResult } from '../test-support/suite.ts'
import { createBranchManager } from './branch.ts'
import { runTuner, type MergeContext, type ProposalContext, type TunerDependencies } from './loop.ts'
import { createPromoter } from './promote.ts'
import type { BlueprintChange, Hypothesis, TunerConfig, TunerReport } from './types.ts'

const GUILD = '/repo'
const WORKSPACE = '/repo/.loom/tuner'

function guildFiles(mode = 'workspace-write'): Record<string, string> {
	return {
		'/repo/loom.json': JSON.stringify({
			entryRole: 'orchestrator',
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] } },
			tools: ['tools/finish.json'],
			routing: { default: { provider: 'test', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			permissions: { mode },
		}),
		'/repo/prompts/orchestrator.md': 'You are the orchestrator.\n',
		'/repo/tools/finish.json': JSON.stringify({
			name: 'finish',
			description: 'End the role.',
			parameters: { type: 'object' },
		}),
	}
}

function hypothesis(id: string, changes: BlueprintChange[]): Hypothesis {
	return { id, motivation: 'because a benchmark fails', mechanism: 'change the prompt', predictedImpact: '+10%', changes }
}

const PROMPT_CHANGE: BlueprintChange = { path: 'prompts/orchestrator.md', content: 'You are the orchestrator. Be brief.\n' }

/** Baseline scores 0.5; anything under a branch directory scores `branchScore`. */
function scoringEvaluator(branchScore: number, heldOutBranchScore = branchScore) {
	return (guildPath: string, split: Split): SuiteResult => {
		const isBranch = guildPath.includes('/branches/')
		const score = split === 'optimization' ? branchScore : heldOutBranchScore
		return isBranch
			? createSuiteResult({ score, low: score === 1 ? 0.7 : 0.2, high: score === 1 ? 1 : 0.8, split })
			: createSuiteResult({ score: 0.5, low: 0.2, high: 0.8, split })
	}
}

interface Harness {
	readonly run: () => Promise<TunerReport>
	readonly evaluated: Array<{ readonly guildPath: string; readonly split: Split }>
	readonly memory: MemoryFileSystem
}

function createHarness(options: {
	readonly hypotheses: readonly Hypothesis[]
	readonly evaluate: (guildPath: string, split: Split) => SuiteResult
	readonly config?: Partial<TunerConfig>
	readonly files?: Record<string, string>
	readonly merge?: (context: MergeContext) => Promise<OpResult<readonly BlueprintChange[]>>
}): Harness {
	const memory = createMemoryFileSystem(options.files ?? guildFiles(), ['/repo', '/repo/prompts', '/repo/tools'])
	const evaluated: Array<{ guildPath: string; split: Split }> = []

	const branch = createBranchManager({ fs: memory.fs, removeDirectory: () => {} }, { workspacePath: WORKSPACE })
	const promoter = createPromoter({ fs: memory.fs, now: () => 1_700_000_000_000 }, { guildPath: GUILD, workspacePath: WORKSPACE })

	const dependencies: TunerDependencies = {
		fs: memory.fs,
		branch,
		promoter,
		evaluate: async (guildPath, split) => {
			evaluated.push({ guildPath, split })
			return options.evaluate(guildPath, split)
		},
		propose: async (_context: ProposalContext) => ok(options.hypotheses),
		pricedModels: [],
		providers: [],
		merge: options.merge ?? (async () => ok([])),
		now: () => 1_700_000_000_000,
	}

	const config: TunerConfig = {
		suitePath: '/suite',
		guildPath: GUILD,
		deploymentPath: '/deployment.json',
		maxCycles: 1,
		maxCostUsd: 10,
		plateauLimit: 1,
		improvementMargin: 0.1,
		costMargin: 0.2,
		repetitions: 1,
		bigModel: { provider: 'stub', model: 'big' },
		...options.config,
	}

	return { run: () => runTuner(dependencies, config), evaluated, memory }
}

describe('runTuner', () => {
	test('a cycle that improves promotes the candidate and reports it', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-001', [PROMPT_CHANGE])],
			evaluate: scoringEvaluator(1),
		})

		const report = await harness.run()

		expect(report.cycles).toHaveLength(1)
		const cycle = report.cycles[0]
		expect(cycle?.branches[0]?.verdict).toBe('improved')
		expect(cycle?.promoted).toBe(true)
		expect(cycle?.heldOut?.verdict).toBe('improved')
		expect(report.history).toHaveLength(1)
	})

	test('promotion archives the previous baseline and installs the candidate', async () => {
		const harness = createHarness({ hypotheses: [hypothesis('h-001', [PROMPT_CHANGE])], evaluate: scoringEvaluator(1) })
		await harness.run()

		const installed = harness.memory.files.get('/repo/prompts/orchestrator.md')
		expect(installed).toContain('Be brief')
		// The outgoing baseline is still on disk, so promotion is reversible.
		expect(harness.memory.files.get(`/repo/.loom/tuner/history/2023-11-14T22-13-20-000Z/prompts/orchestrator.md`)).toBe(
			'You are the orchestrator.\n',
		)
	})

	test('a hypothesis that produces an invalid Blueprint is dropped with its reason', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-bad', [{ path: 'loom.json', content: '{ not json' }])],
			evaluate: scoringEvaluator(1),
		})

		const branch = (await harness.run()).cycles[0]?.branches[0]
		expect(branch?.valid).toBe(false)
		expect(branch?.invalidReason).toContain('not valid JSON')
		expect(branch?.verdict).toBe('noise')
		// It was never scored, and nothing was promoted.
		expect(harness.evaluated.some((call) => call.guildPath.includes('h-bad'))).toBe(false)
	})

	test('a candidate that weakens the permission mode is rejected before it is scored', async () => {
		const weakened = JSON.stringify({
			entryRole: 'orchestrator',
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] } },
			tools: ['tools/finish.json'],
			routing: { default: { provider: 'test', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			permissions: { mode: 'full' },
		})
		const harness = createHarness({
			hypotheses: [hypothesis('h-unsafe', [{ path: 'loom.json', content: weakened }])],
			evaluate: scoringEvaluator(1),
		})

		const report = await harness.run()
		const branch = report.cycles[0]?.branches[0]

		expect(branch?.contractViolations).toHaveLength(1)
		expect(branch?.contractViolations[0]).toContain('weakened')
		expect(report.cycles[0]?.promoted).toBe(false)
		// The point of checking first: it never costs a benchmark run.
		expect(harness.evaluated.some((call) => call.guildPath.includes('h-unsafe'))).toBe(false)
	})

	test('a candidate that improves the optimization split but not the held-out split is not promoted', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-overfit', [PROMPT_CHANGE])],
			// Better where the loop can see; no better where it cannot.
			evaluate: scoringEvaluator(1, 0.5),
		})

		const report = await harness.run()
		const cycle = report.cycles[0]

		expect(cycle?.branches[0]?.verdict).toBe('improved')
		expect(cycle?.heldOut?.verdict).toBe('noise')
		expect(cycle?.promoted).toBe(false)
		expect(cycle?.mergeNote).toContain('held-out split rejected')
		expect(report.history).toEqual([])
	})

	test('a regressing candidate is never promoted', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-worse', [PROMPT_CHANGE])],
			// The baseline passes `a`; the candidate does not.
			evaluate: (guildPath, split) =>
				guildPath.includes('/branches/')
					? createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 0 }, split })
					: createSuiteResult({ score: 0.5, low: 0.1, high: 0.9, benchmarks: { a: 1 }, split }),
		})

		const report = await harness.run()
		expect(report.cycles[0]?.branches[0]?.verdict).toBe('regressed')
		expect(report.cycles[0]?.promoted).toBe(false)
	})

	test('a plateau stops the loop', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-flat', [PROMPT_CHANGE])],
			evaluate: scoringEvaluator(0.5),
			config: { maxCycles: 10, plateauLimit: 2 },
		})

		const report = await harness.run()
		expect(report.cycles).toHaveLength(2)
		expect(report.terminatedBy).toContain('improved nothing')
	})

	test('the cycle budget stops the loop', async () => {
		const harness = createHarness({
			hypotheses: [hypothesis('h-flat', [PROMPT_CHANGE])],
			evaluate: scoringEvaluator(0.5),
			config: { maxCycles: 3, plateauLimit: 99 },
		})

		expect((await harness.run()).cycles).toHaveLength(3)
	})

	test('several accepted hypotheses are combined by the merger', async () => {
		let merged = 0
		const harness = createHarness({
			hypotheses: [hypothesis('h-1', [PROMPT_CHANGE]), hypothesis('h-2', [PROMPT_CHANGE])],
			evaluate: scoringEvaluator(1),
			merge: async (context) => {
				merged += 1
				expect(context.candidates).toHaveLength(2)
				return ok([PROMPT_CHANGE])
			},
		})

		await harness.run()
		expect(merged).toBe(1)
	})

	test('a single accepted hypothesis is used directly, with no merge call', async () => {
		let merged = 0
		const harness = createHarness({
			hypotheses: [hypothesis('h-1', [PROMPT_CHANGE])],
			evaluate: scoringEvaluator(1),
			merge: async () => {
				merged += 1
				return ok([])
			},
		})

		await harness.run()
		expect(merged).toBe(0)
	})

	test('a proposer that fails is recorded, not thrown', async () => {
		const memory = createMemoryFileSystem(guildFiles(), ['/repo', '/repo/prompts', '/repo/tools'])
		const report = await runTuner(
			{
				fs: memory.fs,
				branch: createBranchManager({ fs: memory.fs, removeDirectory: () => {} }, { workspacePath: WORKSPACE }),
				promoter: createPromoter({ fs: memory.fs, now: () => 0 }, { guildPath: GUILD, workspacePath: WORKSPACE }),
				evaluate: async () => createSuiteResult({ score: 0.5 }),
				propose: async () => ({ kind: 'failed', message: 'the model was unavailable' }),
				pricedModels: [],
				providers: [],
				merge: async () => ok([]),
				now: () => 0,
			},
			{
				suitePath: '/suite',
				guildPath: GUILD,
				deploymentPath: '/deployment.json',
				maxCycles: 1,
				maxCostUsd: 10,
				plateauLimit: 1,
				improvementMargin: 0.1,
				costMargin: 0.2,
				repetitions: 1,
				bigModel: { provider: 'stub', model: 'big' },
			},
		)

		expect(report.cycles[0]?.mergeNote).toContain('the proposer failed')
		expect(report.cycles[0]?.branches).toEqual([])
	})
})
