/**
 * What a run cost.
 *
 * Cost is measured and recorded; it is never enforced. A run is bounded by
 * recursion depth, the per-role turn limit, the tool timeout, and the deployment
 * container — not by a dollar ceiling that would either fire on healthy work or
 * never fire at all. See `plan/model-routing.md`.
 */

import type { Usage } from '../model/types.ts'
import type { ModelPrice } from './types.ts'

export const ZERO_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }

export const ZERO_PRICE: ModelPrice = { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 }

/**
 * The bill for one call.
 *
 * `inputTokens` is the full prompt bill and `cachedInputTokens` the subset the
 * provider served from cache, so the uncached portion is the difference — billed
 * at the full rate. Charging the cached tokens twice is the classic way to
 * overstate a bill by an order of magnitude.
 */
export function computeCost(price: ModelPrice, usage: Usage): number {
	const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens
	return (
		(uncachedInputTokens / 1_000_000) * price.inputPer1M +
		(usage.cachedInputTokens / 1_000_000) * price.cachedInputPer1M +
		(usage.outputTokens / 1_000_000) * price.outputPer1M
	)
}

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
	}
}
