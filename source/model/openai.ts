/**
 * An OpenAI-compatible chat-completions client.
 *
 * One client covers OpenAI, llama.cpp's server, Ollama, vLLM, LM Studio,
 * OpenRouter, and most gateways — which is what makes hybrid local/cloud routing
 * cheap to build. `fetch` is injected, so the whole client is exercised in tests
 * against a fake and never touches the network.
 */

import { describeError } from '../errors.ts'
import { isRecord } from '../guards.ts'
import type { ChatRequest, ChatResult, FinishReason, Message, Provider, ToolCall, ToolSpec, Usage } from './types.ts'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OpenAiCompatibleOptions {
	/** Identifies this provider in logs and manifests, e.g. `local` or `together`. */
	readonly id: string
	/** Base URL *without* the trailing `/chat/completions`, e.g. `http://localhost:8080/v1`. */
	readonly baseUrl: string
	/** Sent as `Authorization: Bearer …` when present. */
	readonly apiKey?: string
	readonly fetch: FetchLike
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): Provider {
	const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (options.apiKey !== undefined) headers['authorization'] = `Bearer ${options.apiKey}`

	return {
		id: options.id,
		async chat(request: ChatRequest): Promise<ChatResult> {
			const init: RequestInit = {
				method: 'POST',
				headers,
				body: JSON.stringify(buildRequestBody(request)),
				...(request.signal !== undefined ? { signal: request.signal } : {}),
			}

			let response: Response
			try {
				response = await options.fetch(endpoint, init)
			} catch (error) {
				// A transport failure is a network condition, not a programming
				// error; it is reported as a retryable result rather than thrown.
				return { kind: 'unavailable', message: describeError(error) }
			}

			let text = ''
			try {
				text = await response.text()
			} catch (error) {
				if (response.ok) return { kind: 'unavailable', message: `could not read response body: ${describeError(error)}` }
			}

			if (!response.ok) {
				if (response.status === 429) return { kind: 'rate_limited', message: `HTTP 429: ${text}` }
				// The prompt does not fit the endpoint's context window. Retrying sends
				// the same oversized request, so it is reported rather than retried.
				if (response.status === 400 && text.includes('exceed_context_size_error')) {
					return { kind: 'context_exceeded', message: `HTTP 400: ${text}` }
				}
				// llama-server answers 500 when the model's tool call does not parse.
				// The same request reproduces it, so it is reported rather than retried.
				if (response.status === 500 && text.includes('Failed to parse tool call')) {
					return { kind: 'tool_call_malformed', message: `HTTP 500: ${text}` }
				}
				return { kind: 'unavailable', message: `HTTP ${response.status}: ${text}` }
			}

			let parsed: unknown
			try {
				parsed = JSON.parse(text)
			} catch (error) {
				return { kind: 'invalid_response', message: `response body is not JSON: ${describeError(error)}` }
			}
			return parseChatCompletion(parsed)
		},
	}
}

/**
 * Maps an OpenAI-compatible chat-completions body to a `ChatResult`. Exported as
 * a test seam: the shape checks are the part most worth pinning down.
 */
export function parseChatCompletion(value: unknown): ChatResult {
	if (!isRecord(value)) return { kind: 'invalid_response', message: 'response is not an object' }

	const choices = value['choices']
	if (!Array.isArray(choices) || choices.length === 0) return { kind: 'invalid_response', message: 'response has no choices' }
	const choice: unknown = choices[0]
	if (!isRecord(choice)) return { kind: 'invalid_response', message: 'choice is not an object' }

	const message = choice['message']
	if (!isRecord(message)) return { kind: 'invalid_response', message: 'choice has no message' }

	const toolCalls = parseToolCalls(message['tool_calls'])
	if (toolCalls === null) return { kind: 'invalid_response', message: 'message has malformed tool_calls' }

	const content = typeof message['content'] === 'string' ? message['content'] : ''
	const reasoning = typeof message['reasoning_content'] === 'string' ? message['reasoning_content'] : undefined

	return {
		kind: 'success',
		response: {
			content,
			...(reasoning !== undefined ? { reasoning } : {}),
			toolCalls,
			usage: parseUsage(value['usage']),
			finishReason: parseFinishReason(choice['finish_reason']),
		},
	}
}

function parseToolCalls(value: unknown): ToolCall[] | null {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) return null

	const calls: ToolCall[] = []
	for (const entry of value) {
		if (!isRecord(entry)) return null
		const call = entry['function']
		if (!isRecord(call)) return null
		const id = entry['id']
		const name = call['name']
		if (typeof id !== 'string' || typeof name !== 'string') return null
		const rawArguments = call['arguments']
		const args = typeof rawArguments === 'string' ? rawArguments : isRecord(rawArguments) ? JSON.stringify(rawArguments) : ''
		calls.push({ id, name, arguments: args })
	}
	return calls
}

function parseUsage(value: unknown): Usage {
	if (!isRecord(value)) return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
	const details = value['prompt_tokens_details']
	return {
		inputTokens: typeof value['prompt_tokens'] === 'number' ? value['prompt_tokens'] : 0,
		cachedInputTokens: isRecord(details) && typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : 0,
		outputTokens: typeof value['completion_tokens'] === 'number' ? value['completion_tokens'] : 0,
	}
}

// A provider that omits `finish_reason` is not an error — it is a normal answer.
function parseFinishReason(value: unknown): FinishReason {
	if (value === 'tool_calls' || value === 'length' || value === 'error') return value
	return 'stop'
}

function buildRequestBody(request: ChatRequest): Record<string, unknown> {
	return {
		model: request.model,
		messages: request.messages.map(toWireMessage),
		...(request.tools.length > 0 ? { tools: request.tools.map(toWireTool) } : {}),
		temperature: request.temperature,
		max_tokens: request.maxTokens,
	}
}

function toWireMessage(message: Message): Record<string, unknown> {
	const wire: Record<string, unknown> = { role: message.role, content: message.content }
	if (message.toolCallId !== undefined) wire['tool_call_id'] = message.toolCallId
	if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
		wire['tool_calls'] = message.toolCalls.map((call) => ({
			id: call.id,
			type: 'function',
			function: { name: call.name, arguments: call.arguments },
		}))
	}
	return wire
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
	return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}
