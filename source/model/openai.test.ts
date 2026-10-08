import { describe, expect, test } from 'bun:test'
import { createOpenAiCompatibleProvider, parseChatCompletion } from './openai.ts'
import type { ChatRequest } from './types.ts'

const request: ChatRequest = {
	model: 'qwen3-coder-30b',
	messages: [{ role: 'user', content: 'hello' }],
	tools: [{ name: 'finish', description: 'End.', parameters: { type: 'object' } }],
	temperature: 0.1,
	maxTokens: 1024,
}

const completion = {
	choices: [
		{
			message: {
				role: 'assistant',
				content: 'hi',
				tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{"status":"success"}' } }],
			},
			finish_reason: 'tool_calls',
		},
	],
	usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
}

describe('createOpenAiCompatibleProvider', () => {
	test('sends the expected request and maps the completion to a success result', async () => {
		let capturedUrl = ''
		let capturedBody: unknown = undefined
		let capturedHeaders: unknown = undefined

		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			// A trailing slash must not produce a doubled separator.
			baseUrl: 'http://localhost:8080/v1/',
			apiKey: 'secret',
			fetch: async (url, init) => {
				capturedUrl = url
				capturedBody = JSON.parse(String(init.body))
				capturedHeaders = init.headers
				return Response.json(completion)
			},
		})

		const result = await provider.chat(request)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)

		expect(result.response.content).toBe('hi')
		expect(result.response.toolCalls).toEqual([{ id: 'c1', name: 'finish', arguments: '{"status":"success"}' }])
		expect(result.response.usage).toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 })
		expect(result.response.finishReason).toBe('tool_calls')

		expect(capturedUrl).toBe('http://localhost:8080/v1/chat/completions')
		expect(capturedHeaders).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret' })
		expect(capturedBody).toEqual({
			model: 'qwen3-coder-30b',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [{ type: 'function', function: { name: 'finish', description: 'End.', parameters: { type: 'object' } } }],
			temperature: 0.1,
			max_tokens: 1024,
		})
	})

	test('omits the tools field entirely when the request declares none', async () => {
		let capturedBody: Record<string, unknown> = {}
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async (_url, init) => {
				capturedBody = JSON.parse(String(init.body))
				return Response.json(completion)
			},
		})

		await provider.chat({ ...request, tools: [] })
		expect('tools' in capturedBody).toBe(false)
	})

	test('maps HTTP 429 to a retryable rate_limited result', async () => {
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async () => new Response('slow down', { status: 429 }),
		})
		const result = await provider.chat(request)
		expect(result.kind).toBe('rate_limited')
	})

	test('maps a server error to an unavailable result carrying the status', async () => {
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async () => new Response('boom', { status: 500 }),
		})
		const result = await provider.chat(request)
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'unavailable') throw new Error('unreachable')
		expect(result.message).toContain('500')
	})

	test('maps a parse-failure 500 to tool_call_malformed, not a retryable unavailable', async () => {
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async () => new Response('{"error":"Failed to parse tool call arguments as JSON"}', { status: 500 }),
		})
		const result = await provider.chat(request)
		expect(result.kind).toBe('tool_call_malformed')
	})

	test('maps a transport failure to an unavailable result rather than throwing', async () => {
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async () => {
				throw new Error('connection refused')
			},
		})
		const result = await provider.chat(request)
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'unavailable') throw new Error('unreachable')
		expect(result.message).toBe('connection refused')
	})

	test('maps a non-JSON body to an invalid_response result', async () => {
		const provider = createOpenAiCompatibleProvider({
			id: 'local',
			baseUrl: 'http://localhost:8080/v1',
			fetch: async () => new Response('<html>gateway</html>', { status: 200 }),
		})
		const result = await provider.chat(request)
		expect(result.kind).toBe('invalid_response')
	})
})

describe('parseChatCompletion', () => {
	test('treats a missing finish_reason as a normal stop', () => {
		const result = parseChatCompletion({ choices: [{ message: { content: 'ok' } }] })
		if (result.kind !== 'success') throw new Error('expected success')
		expect(result.response.finishReason).toBe('stop')
		expect(result.response.toolCalls).toEqual([])
	})

	test('defaults usage to zero when the provider reports none', () => {
		const result = parseChatCompletion({ choices: [{ message: { content: 'ok' } }] })
		if (result.kind !== 'success') throw new Error('expected success')
		expect(result.response.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
	})

	test('accepts an object-valued arguments field and serializes it', () => {
		const result = parseChatCompletion({
			choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'finish', arguments: { status: 'success' } } }] } }],
		})
		if (result.kind !== 'success') throw new Error('expected success')
		expect(result.response.toolCalls[0]?.arguments).toBe('{"status":"success"}')
	})

	test('carries reasoning through when the provider returns it', () => {
		const result = parseChatCompletion({ choices: [{ message: { content: 'ok', reasoning_content: 'thinking' } }] })
		if (result.kind !== 'success') throw new Error('expected success')
		expect(result.response.reasoning).toBe('thinking')
	})

	test('rejects a body with no choices', () => {
		expect(parseChatCompletion({ choices: [] }).kind).toBe('invalid_response')
	})

	test('rejects a body whose choice has no message', () => {
		expect(parseChatCompletion({ choices: [{}] }).kind).toBe('invalid_response')
	})

	test('rejects a body that is not an object', () => {
		expect(parseChatCompletion('nope').kind).toBe('invalid_response')
	})

	test('rejects malformed tool_calls rather than silently dropping them', () => {
		const result = parseChatCompletion({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c' }] } }] })
		expect(result.kind).toBe('invalid_response')
	})
})
