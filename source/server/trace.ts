/**
 * The trace: what a run did, as spans.
 *
 * Derived from the event log rather than emitted live, because the log is
 * already the authority on what happened — a second, in-memory trace would be a
 * second version of the truth, and the two would drift.
 *
 * The shape is OpenTelemetry's: a span has an id, a parent, a name, a kind, a
 * start and (usually) an end, attributes, and a cost. Exporting them through the
 * OTel SDK is a dependency this project does not carry; the data is what matters
 * here, and the endpoint serves it as JSON.
 */

import type { ModelPrice } from '../deployment/types.ts'
import { computeCost, ZERO_PRICE } from '../deployment/cost.ts'
import type { Usage } from '../model/types.ts'
import type { RunLogRecord } from '../runs/validate.ts'

export type SpanKind = 'agent' | 'turn' | 'tool'

export interface TraceSpan {
	readonly id: string
	readonly parentId: string | null
	readonly name: string
	readonly kind: SpanKind
	readonly agentId: string
	readonly startedAt: string
	readonly finishedAt: string | null
	readonly attributes: Readonly<Record<string, unknown>>
	readonly costUsd: number
	readonly usage: Usage | null
}

function readString(event: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = event[key]
	return typeof value === 'string' ? value : null
}

function readUsage(event: Readonly<Record<string, unknown>>): Usage | null {
	const usage = event['usage']
	if (typeof usage !== 'object' || usage === null) return null
	const record = usage as Readonly<Record<string, unknown>>
	const input = record['inputTokens']
	const cached = record['cachedInputTokens']
	const output = record['outputTokens']
	if (typeof input !== 'number' || typeof cached !== 'number' || typeof output !== 'number') return null
	return { inputTokens: input, cachedInputTokens: cached, outputTokens: output }
}

/**
 * One span per agent, one per turn, one per tool call — nested by what caused
 * what. A turn's cost is priced by the model recorded on its finish event, so the
 * trace attributes spend to the step that incurred it.
 */
export function buildTrace(records: readonly RunLogRecord[], prices: Readonly<Record<string, ModelPrice>>): readonly TraceSpan[] {
	const spans: TraceSpan[] = []
	const agentSpans = new Map<string, string>()

	for (const record of records) {
		const event = record.event
		const agentId = readString(event, 'agentId') ?? readString(event, 'role') ?? 'run'

		if (record.type === 'agent_start') {
			const id = `agent:${agentId}`
			const parentId = readString(event, 'parentId')
			agentSpans.set(agentId, id)
			spans.push({
				id,
				// A subagent's span hangs off the agent that delegated to it.
				parentId: parentId === null ? null : `agent:${parentId}`,
				name: `agent ${readString(event, 'role') ?? agentId}`,
				kind: 'agent',
				agentId,
				startedAt: record.at,
				finishedAt: null,
				attributes: { role: readString(event, 'role') ?? null, depth: event['depth'] ?? null },
				costUsd: 0,
				usage: null,
			})
			continue
		}

		if (record.type === 'model_call') {
			const id = `turn:${agentId}:${String(record.index)}`
			const usage = readUsage(event)
			const model = readString(event, 'model') ?? ''
			const price = prices[model] ?? ZERO_PRICE
			spans.push({
				id,
				parentId: agentSpans.get(agentId) ?? null,
				name: `model call ${model}`,
				kind: 'turn',
				agentId,
				startedAt: record.at,
				finishedAt: record.at,
				attributes: {
					model,
					messageCount: event['messageCount'] ?? null,
					durationMs: event['durationMs'] ?? null,
				},
				costUsd: usage === null ? 0 : computeCost(price, usage),
				usage,
			})
			continue
		}

		if (record.type === 'tool_result') {
			const tool = readString(event, 'tool') ?? 'tool'
			spans.push({
				id: `tool:${agentId}:${String(record.index)}`,
				parentId: agentSpans.get(agentId) ?? null,
				name: `tool ${tool}`,
				kind: 'tool',
				agentId,
				startedAt: record.at,
				finishedAt: record.at,
				attributes: { tool, kind: event['kind'] ?? null, result: event['result'] ?? null },
				costUsd: 0,
				usage: null,
			})
			continue
		}

		if (record.type === 'agent_finish') {
			const id = agentSpans.get(agentId)
			if (id === undefined) continue
			const index = spans.findIndex((span) => span.id === id)
			const existing = spans[index]
			if (existing === undefined) continue
			spans[index] = {
				...existing,
				finishedAt: record.at,
				attributes: { ...existing.attributes, status: event['status'] ?? null, summary: event['summary'] ?? null },
				costUsd: typeof event['costUsd'] === 'number' ? event['costUsd'] : 0,
				usage: readUsage(event),
			}
		}
	}

	return spans
}
