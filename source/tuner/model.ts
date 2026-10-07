/**
 * The big model: proposing hypotheses, and merging accepted ones.
 *
 * This is the one place a large model enters the project. The engine runs on a
 * small model; the Tuner uses a large one to improve the conditions the small
 * one works under — which is the whole asymmetry the project is built on.
 *
 * The system prompt states the promotion contract, so a model is told the rules
 * rather than left to discover them by having its work discarded.
 */

import { ValidationError } from '../errors.ts'
import { isRecord } from '../guards.ts'
import type { FinishReason, Provider, Usage } from '../model/types.ts'
import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import { parseHypotheses } from './hypothesis.ts'
import type { MergeContext, ProposalContext } from './loop.ts'
import type { BlueprintChange, Hypothesis } from './types.ts'

export interface BigModelDependencies {
	readonly provider: Provider
	readonly model: string
}

const CONTRACT_RULES = `Rules you must not break. A proposal that breaks one is discarded unread:
- Do not weaken permissions.mode (read-only < workspace-write < full).
- Do not give a role a workspace-mutating tool (write_file, run_shell, typecheck, test) unless that role is worktree-isolated.
- "content" is the whole file, never a diff. Paths are relative to the Blueprint directory.`

const PROPOSAL_SYSTEM = `You improve a multi-agent orchestration configuration called a Blueprint.

A Blueprint is a JSON document plus the prompt and tool-manifest files it references. Roles delegate to one another; the entry role receives the task.

Reply with a JSON array of hypotheses and nothing else:
[
  {
    "id": "h-001",
    "motivation": "why, in terms of an observed failure",
    "mechanism": "the concrete change",
    "predictedImpact": "what it should move, and roughly how much",
    "changes": [{ "path": "prompts/coder.md", "content": "the complete new contents of that file" }]
  }
]

${CONTRACT_RULES}
Propose few, concrete, testable changes. Vague wording tweaks are worthless.`

const MERGE_SYSTEM = `You combine several accepted edits to a Blueprint into one coherent set.

Reply with a JSON array of changes and nothing else:
[{ "path": "prompts/coder.md", "content": "the complete new contents of that file" }]

Where two edits touch the same file, produce one file that keeps the intent of both.

${CONTRACT_RULES}`

/** Pulls a JSON value out of a reply, tolerating a fenced code block. */
export function extractJson(content: string): unknown | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
	const candidate = fenced?.[1] ?? content
	try {
		return JSON.parse(candidate.trim())
	} catch {
		return null
	}
}

function renderProposalRequest(context: ProposalContext): string {
	const failures =
		context.failingBenchmarks.length === 0
			? 'Every benchmark passes. Propose changes that make the result cheaper or more robust without losing a pass.'
			: `Benchmarks that are not fully passing:\n${context.failingBenchmarks.map((line) => `- ${line}`).join('\n')}`

	const catalog =
		context.pricedModels.length === 0
			? ''
			: `\n\nModels this deployment prices, which are the only ones a change may name:\n${context.pricedModels
					.map((line) => `- ${line}`)
					.join('\n')}`

	const editable =
		context.editableFiles.length === 0
			? ''
			: `\n\nThese are the only files a change may name, relative to the Blueprint directory:\n${context.editableFiles
					.map((file) => `- ${file}`)
					.join('\n')}\nA change to any other path is written and then read by nothing, so the candidate is discarded.`

	return `The current Blueprint:\n\n${context.blueprint}${editable}${catalog}\n\n${failures}`
}

/**
 * The output ceiling for a proposal or a merge.
 *
 * A proposal carries whole file contents, and a reasoning model spends part of
 * the same budget thinking before it writes any of them — so this is generous on
 * purpose. It is a ceiling, not a target: a model that answers in 500 tokens is
 * not charged for the rest.
 */
const BIG_MODEL_MAX_TOKENS = 32768

/** A reply that ran out of room is a different failure from a reply that was never JSON. */
function diagnoseReply(result: { readonly finishReason: FinishReason; readonly usage: Usage }): string | null {
	if (result.finishReason === 'length') {
		const total = result.usage.inputTokens + result.usage.outputTokens
		return `the reply was cut off at the ${String(BIG_MODEL_MAX_TOKENS)}-token ceiling after ${String(total)} tokens; the JSON was incomplete`
	}
	return null
}

export function createHypothesisProposer(
	dependencies: BigModelDependencies,
): (context: ProposalContext) => Promise<OpResult<readonly Hypothesis[]>> {
	return async (context) => {
		const result = await dependencies.provider.chat({
			model: dependencies.model,
			messages: [
				{ role: 'system', content: PROPOSAL_SYSTEM },
				{ role: 'user', content: renderProposalRequest(context) },
			],
			tools: [],
			// Warmer than a run: hypotheses should differ from one another.
			temperature: 0.7,
			maxTokens: BIG_MODEL_MAX_TOKENS,
		})
		if (result.kind !== 'success') return failed(`the proposer could not be reached: ${result.message}`)

		// Checked before the parse, because a truncated reply is not a malformed
		// one: reporting it as "not JSON" sends the reader looking for a prompt
		// problem when the answer is a token budget.
		const truncated = diagnoseReply(result.response)
		if (truncated !== null) return failed(truncated)

		const parsed = extractJson(result.response.content)
		if (parsed === null) return failed('the proposer did not reply with JSON')

		try {
			return ok(parseHypotheses(parsed, 'hypotheses'))
		} catch (error) {
			// A model that produced malformed hypotheses has failed this cycle; the
			// reason is recorded rather than thrown into the loop.
			if (error instanceof ValidationError) return failed(error.message)
			throw error
		}
	}
}

export function createChangeMerger(
	dependencies: BigModelDependencies,
): (context: MergeContext) => Promise<OpResult<readonly BlueprintChange[]>> {
	return async (context) => {
		const rendered = context.candidates
			.map(
				(candidate) =>
					`### ${candidate.id}\nMotivation: ${candidate.motivation}\n${candidate.changes
						.map((change) => `\n--- ${change.path} ---\n${change.content}`)
						.join('\n')}`,
			)
			.join('\n\n')

		const result = await dependencies.provider.chat({
			model: dependencies.model,
			messages: [
				{ role: 'system', content: MERGE_SYSTEM },
				{ role: 'user', content: `The baseline Blueprint:\n\n${context.baseline}\n\nAccepted edits:\n\n${rendered}` },
			],
			tools: [],
			temperature: 0,
			maxTokens: BIG_MODEL_MAX_TOKENS,
		})
		if (result.kind !== 'success') return failed(`the merger could not be reached: ${result.message}`)

		const truncated = diagnoseReply(result.response)
		if (truncated !== null) return failed(truncated)

		const parsed = extractJson(result.response.content)
		if (parsed === null) return failed('the merger did not reply with JSON')

		if (!Array.isArray(parsed)) return failed('the merger did not reply with an array of changes')
		const changes: BlueprintChange[] = []
		for (const entry of parsed) {
			if (!isRecord(entry)) return failed('a merged change is not an object')
			const target = entry['path']
			const content = entry['content']
			if (typeof target !== 'string' || typeof content !== 'string') {
				return failed('a merged change is missing "path" or "content"')
			}
			changes.push({ path: target, content })
		}
		return ok(changes)
	}
}
