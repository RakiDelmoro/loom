/**
 * The model boundary.
 *
 * Everything above this file talks to `Provider` and never to a vendor. Every
 * call resolves to a `ChatResult` — failures are values, not thrown exceptions,
 * so the caller decides how to recover (retry, fall back, hand off, give up).
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
	readonly id: string
	readonly name: string
	/** The raw JSON string of arguments, exactly as the model produced it. */
	readonly arguments: string
}

export interface Message {
	readonly role: MessageRole
	readonly content: string
	/** Set on `tool` messages: the call this message answers. */
	readonly toolCallId?: string
	/** Set on `assistant` messages that requested tools. */
	readonly toolCalls?: readonly ToolCall[]
}

export interface ToolSpec {
	readonly name: string
	readonly description: string
	readonly parameters: Readonly<Record<string, unknown>>
}

export interface ChatRequest {
	readonly model: string
	readonly messages: readonly Message[]
	readonly tools: readonly ToolSpec[]
	readonly temperature: number
	readonly maxTokens: number
	readonly signal?: AbortSignal
}

export interface Usage {
	/** The full prompt bill (cached + uncached). */
	readonly inputTokens: number
	/** The subset of `inputTokens` the provider served from its prompt cache. */
	readonly cachedInputTokens: number
	readonly outputTokens: number
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error'

export interface ChatResponse {
	readonly content: string
	readonly reasoning?: string
	readonly toolCalls: readonly ToolCall[]
	readonly usage: Usage
	readonly finishReason: FinishReason
}

/**
 * The outcome of one model call. `unavailable` and `timeout` are retryable;
 * `invalid_response` means the provider answered with something unparseable;
 * `rate_limited` carries the provider's own signal.
 */
export type ChatResult =
	| { readonly kind: 'success'; readonly response: ChatResponse }
	| { readonly kind: 'unavailable'; readonly message: string }
	| { readonly kind: 'timeout'; readonly message: string }
	| { readonly kind: 'rate_limited'; readonly message: string }
	| { readonly kind: 'invalid_response'; readonly message: string }

export interface Provider {
	readonly id: string
	chat(request: ChatRequest): Promise<ChatResult>
}
