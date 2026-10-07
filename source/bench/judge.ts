/**
 * The LLM judge, for work that is not binary.
 *
 * A judge is a measured liability: a noisy one destroys the harness. So it is
 * pinned to a rubric, run at temperature 0, and never told who produced the
 * work — and its verdict only ever *raises* a score above zero. A deterministic
 * failure is never overturned by a judge.
 */

import type { Provider } from '../model/types.ts'
import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'

export interface JudgeRequest {
	readonly task: string
	readonly rubric: string
	/** What the validation actually observed: the command, its output, why it failed. */
	readonly evidence: string
}

export interface JudgeDependencies {
	readonly provider: Provider
	readonly model: string
}

const MAX_EVIDENCE_CHARS = 4000

/** The first integer 0–3 anywhere in the reply. */
export function parseJudgeScore(content: string): number | null {
	const match = /[0-3]/.exec(content)
	if (match === null) return null
	return Number(match[0])
}

/** Scores the work 0–3 and returns it normalized to 0–1. */
export async function judgeWork(dependencies: JudgeDependencies, request: JudgeRequest): Promise<OpResult<number>> {
	const result = await dependencies.provider.chat({
		model: dependencies.model,
		messages: [
			{
				role: 'system',
				content: `You grade one piece of work against a rubric. Reply with a single integer from 0 to 3 and nothing else.\n\nRubric: ${request.rubric}`,
			},
			{
				role: 'user',
				content: `Task:\n${request.task}\n\nWhat the checks observed:\n${request.evidence.slice(0, MAX_EVIDENCE_CHARS)}`,
			},
		],
		tools: [],
		temperature: 0,
		maxTokens: 8,
	})

	if (result.kind !== 'success') return failed(`the judge could not be reached: ${result.message}`)

	const score = parseJudgeScore(result.response.content)
	if (score === null) return failed(`the judge did not reply with a score from 0 to 3: ${result.response.content.slice(0, 80)}`)

	return ok(score / 3)
}
