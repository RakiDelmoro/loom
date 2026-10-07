/**
 * The optimization loop.
 *
 * A cycle is a small study: measure the baseline, ask for hypotheses, test each
 * one, and promote only what also improves on the half of the suite the loop
 * never optimized against.
 *
 * Every expensive step is injected — the evaluator, the proposer, the merger —
 * so the whole loop is exercisable in memory, and so the loop itself contains no
 * model call and no benchmark run.
 */

import * as path from 'node:path'
import { loadBlueprint } from '../blueprint/load.ts'
import type { Split, SuiteResult } from '../bench/types.ts'
import type { FileSystem } from '../fs.ts'
import type { OpResult } from '../result.ts'
import { readBlueprintFiles, type BranchManager } from './branch.ts'
import { compare } from './compare.ts'
import { contractViolations, type ContractView } from './contract.ts'
import { advance, shouldTerminate, type Termination } from './guardrails.ts'
import type { Promoter } from './promote.ts'
import type { BlueprintChange, BranchOutcome, CycleReport, HeldOutGate, Hypothesis, TunerConfig, TunerReport, TunerState } from './types.ts'

export interface ProposalContext {
	readonly blueprint: string
	readonly failingBenchmarks: readonly string[]
	/**
	 * The files a change may name — the Blueprint document and everything it
	 * references. A proposer that does not know the Blueprint's filename guesses
	 * one, writes a file nothing reads, and produces a candidate identical to the
	 * baseline.
	 */
	readonly editableFiles: readonly string[]
	/**
	 * The models the deployment prices, with what each costs.
	 *
	 * A proposer asked to make a run cheaper cannot name a cheaper model it has
	 * never heard of, and the Blueprint only names the one in use. The price table
	 * is the catalog.
	 */
	readonly pricedModels: readonly string[]
}

export interface MergeContext {
	readonly baseline: string
	readonly candidates: readonly {
		readonly id: string
		readonly motivation: string
		readonly changes: readonly BlueprintChange[]
	}[]
}

export interface TunerDependencies {
	readonly fs: FileSystem
	readonly branch: BranchManager
	readonly promoter: Promoter
	/** Runs the suite against a guild directory, for one split. */
	readonly evaluate: (guildPath: string, split: Split) => Promise<SuiteResult>
	readonly propose: (context: ProposalContext) => Promise<OpResult<readonly Hypothesis[]>>
	/** `model — $in/$out per 1M`, for the proposer. Empty when the deployment prices nothing. */
	readonly pricedModels: readonly string[]
	readonly merge: (context: MergeContext) => Promise<OpResult<readonly BlueprintChange[]>>
	readonly now: () => number
	readonly onEvent?: (message: string) => void
}

const MERGED_BRANCH = 'merged'

export async function runTuner(dependencies: TunerDependencies, config: TunerConfig): Promise<TunerReport> {
	const startedAt = dependencies.now()
	const cycles: CycleReport[] = []
	let state: TunerState = { cycles: 0, costUsd: 0, plateau: 0 }
	let terminatedBy = 'the loop stopped without a stated reason'

	for (;;) {
		const termination: Termination = shouldTerminate(state, config)
		if (termination.stop) {
			terminatedBy = termination.reason ?? terminatedBy
			break
		}

		const cycle = await runCycle(dependencies, config, state.cycles + 1)
		cycles.push(cycle)
		state = advance(state, { improved: cycle.promoted ? 1 : 0, costUsd: cycle.costUsd })
		// "we searched and found nothing" and "we never searched" are different
		// results, and a cycle line that says "no promotion" for both hides the
		// second — which is the one an operator needs to act on.
		const outcome = cycle.promoted
			? 'promoted a new baseline'
			: cycle.branches.length === 0
				? `nothing was proposed: ${cycle.mergeNote ?? 'no reason recorded'}`
				: 'no promotion'
		dependencies.onEvent?.(`cycle ${String(cycle.cycle)}: ${outcome}`)
	}

	return {
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(dependencies.now()).toISOString(),
		guildPath: config.guildPath,
		cycles,
		terminatedBy,
		costUsd: state.costUsd,
		history: dependencies.promoter.history(),
	}
}

async function runCycle(
	dependencies: TunerDependencies,
	config: TunerConfig,
	cycleNumber: number,
): Promise<CycleReport> {
	const baseline = await dependencies.evaluate(config.guildPath, 'optimization')
	let costUsd = baseline.costUsd

	const blueprintPath = path.join(config.guildPath, 'loom.json')
	const document = dependencies.fs.readTextFile(blueprintPath)
	const blueprintText = document.kind === 'ok' ? document.text : ''
	const baselineView: ContractView = loadBlueprint({ readTextFile: dependencies.fs.readTextFile }, blueprintPath)

	const proposed = await dependencies.propose({
		blueprint: blueprintText,
		editableFiles: readBlueprintFiles(dependencies.fs, config.guildPath),
		pricedModels: dependencies.pricedModels,
		failingBenchmarks: baseline.benchmarks
			.filter((summary) => summary.passRate < 1)
			.map((summary) => `${summary.benchmark} (${String(summary.passes)}/${String(summary.runs)})`),
	})
	if (proposed.kind !== 'ok') {
		return cycleReport(cycleNumber, baseline, [], [], `the proposer failed: ${proposed.message}`, null, false, costUsd)
	}

	const branches: BranchOutcome[] = []
	for (const hypothesis of proposed.value) {
		branches.push(await evaluateHypothesis(dependencies, config, hypothesis, baseline, baselineView))
	}
	costUsd += branches.reduce((total, branch) => total + branch.costUsd, 0)

	const accepted = branches.filter((branch) => branch.verdict === 'improved')
	if (accepted.length === 0) {
		return cycleReport(cycleNumber, baseline, branches, [], 'no hypothesis improved the baseline', null, false, costUsd)
	}

	let changes: readonly BlueprintChange[]
	if (accepted.length === 1) {
		changes = accepted[0]?.hypothesis.changes ?? []
	} else {
		const merged = await dependencies.merge({
			baseline: blueprintText,
			candidates: accepted.map((branch) => ({
				id: branch.branchId,
				motivation: branch.hypothesis.motivation,
				changes: branch.hypothesis.changes,
			})),
		})
		if (merged.kind !== 'ok') {
			return cycleReport(cycleNumber, baseline, branches, [], `the merge failed: ${merged.message}`, null, false, costUsd)
		}
		changes = merged.value
	}

	// The merged candidate is a *new* artifact, so it is validated and evaluated
	// on its own — combining two good branches can still produce a bad one.
	const materialized = dependencies.branch.create(MERGED_BRANCH, changes, config.guildPath)
	if (materialized.kind !== 'ok') {
		return cycleReport(cycleNumber, baseline, branches, changes, `the merged candidate is not valid: ${materialized.message}`, null, false, costUsd)
	}

	// The gate: promotion needs improvement on the half the loop never optimized
	// against. Both halves are measured in the same cycle, against the same
	// baseline.
	const candidateHeldOut = await dependencies.evaluate(dependencies.branch.guildPath(MERGED_BRANCH), 'held-out')
	const baselineHeldOut = await dependencies.evaluate(config.guildPath, 'held-out')
	costUsd += candidateHeldOut.costUsd + baselineHeldOut.costUsd

	const gate = compare(baselineHeldOut, candidateHeldOut, { margin: config.improvementMargin, costMargin: config.costMargin })
	const heldOut: HeldOutGate = {
		evaluated: true,
		baselineScore: baselineHeldOut.score,
		candidateScore: candidateHeldOut.score,
		verdict: gate.verdict,
		reason: gate.reasons.join('; '),
	}

	if (gate.verdict !== 'improved') {
		return cycleReport(cycleNumber, baseline, branches, changes, 'the held-out split rejected the candidate', heldOut, false, costUsd)
	}

	const promoted = dependencies.promoter.promote(MERGED_BRANCH)
	if (promoted.kind !== 'ok') {
		return cycleReport(cycleNumber, baseline, branches, changes, `promotion failed: ${promoted.message}`, heldOut, false, costUsd)
	}

	return cycleReport(cycleNumber, baseline, branches, changes, null, heldOut, true, costUsd)
}

async function evaluateHypothesis(
	dependencies: TunerDependencies,
	config: TunerConfig,
	hypothesis: Hypothesis,
	baseline: SuiteResult,
	baselineView: ContractView,
): Promise<BranchOutcome> {
	const branchId = hypothesis.id
	const created = dependencies.branch.create(branchId, hypothesis.changes, config.guildPath)

	const shell = {
		branchId,
		hypothesis,
		optimizationScore: 0,
		optimizationInterval: { low: 0, high: 0 },
		verdict: 'noise' as const,
		verdictReasons: [] as readonly string[],
		costUsd: 0,
	}

	if (created.kind !== 'ok') {
		return { ...shell, valid: false, invalidReason: created.message, contractViolations: [], verdictReasons: ['the candidate Blueprint does not load'] }
	}

	// Safety is checked before the candidate is ever scored: a search left to
	// itself will trade it away for a better number.
	const violations = contractViolations(baselineView, created.value)
	if (violations.length > 0) {
		return { ...shell, valid: true, invalidReason: null, contractViolations: violations, verdictReasons: ['rejected by the promotion contract'] }
	}

	const evaluated = await dependencies.evaluate(dependencies.branch.guildPath(branchId), 'optimization')
	const comparison = compare(baseline, evaluated, { margin: config.improvementMargin, costMargin: config.costMargin })

	return {
		...shell,
		valid: true,
		invalidReason: null,
		contractViolations: [],
		optimizationScore: evaluated.score,
		optimizationInterval: evaluated.interval,
		verdict: comparison.verdict,
		verdictReasons: comparison.reasons,
		costUsd: evaluated.costUsd,
	}
}

function cycleReport(
	cycle: number,
	baseline: SuiteResult,
	branches: readonly BranchOutcome[],
	mergedChanges: readonly BlueprintChange[],
	mergeNote: string | null,
	heldOut: HeldOutGate | null,
	promoted: boolean,
	costUsd: number,
): CycleReport {
	return {
		cycle,
		baselineScore: baseline.score,
		baselineInterval: baseline.interval,
		branches,
		mergedChanges,
		mergeNote,
		heldOut,
		promoted,
		costUsd,
	}
}
