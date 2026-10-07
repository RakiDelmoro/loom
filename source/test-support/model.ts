import type { ChatResult, ToolCall, Usage } from '../model/types.ts'

export const ZERO_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }

/** A reply that asks for no tools — which the loop treats as a finish. */
export function textResponse(content: string, usage: Usage = ZERO_USAGE): ChatResult {
	return { kind: 'success', response: { content, toolCalls: [], usage, finishReason: 'stop' } }
}

export function toolCallResponse(calls: readonly ToolCall[], usage: Usage = ZERO_USAGE): ChatResult {
	return { kind: 'success', response: { content: '', toolCalls: calls, usage, finishReason: 'tool_calls' } }
}

/** Builds a tool call whose arguments are serialized the way a provider would. */
export function call(id: string, name: string, args: unknown): ToolCall {
	return { id, name, arguments: JSON.stringify(args) }
}
