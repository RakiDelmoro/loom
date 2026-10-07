import type { ChatResult, ToolCall, Usage } from '../model/types.ts'

const EMPTY_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }

/** A reply that asks for no tools — which the loop treats as a finish. */
export function textResponse(content: string): ChatResult {
	return { kind: 'success', response: { content, toolCalls: [], usage: EMPTY_USAGE, finishReason: 'stop' } }
}

export function toolCallResponse(calls: readonly ToolCall[]): ChatResult {
	return { kind: 'success', response: { content: '', toolCalls: calls, usage: EMPTY_USAGE, finishReason: 'tool_calls' } }
}

/** Builds a tool call whose arguments are serialized the way a provider would. */
export function call(id: string, name: string, args: unknown): ToolCall {
	return { id, name, arguments: JSON.stringify(args) }
}
