import { describe, expect, test } from 'bun:test'
import type { ChatRequest } from '../model/types.ts'
import { createProviderRegistry } from './registry.ts'
import type { Deployment } from './types.ts'

const deployment: Deployment = {
	providers: {
		local: { baseUrl: 'http://localhost:8080/v1' },
		anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' },
	},
	prices: {},
}

const request: ChatRequest = { model: 'm', messages: [], tools: [], temperature: 0, maxTokens: 16 }

const completion = { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }

describe('createProviderRegistry', () => {
	test('builds a provider whose credential comes from the named environment variable', async () => {
		let headers: unknown
		const registry = createProviderRegistry(
			{
				env: { ANTHROPIC_API_KEY: 'secret-value' },
				fetch: async (_url, init) => {
					headers = init.headers
					return Response.json(completion)
				},
			},
			deployment,
		)

		const created = registry.create('anthropic')
		if (created.kind !== 'ok') throw new Error(created.message)
		await created.value.chat(request)

		expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret-value' })
	})

	test('sends no credential for a provider that names none', async () => {
		let headers: unknown
		const registry = createProviderRegistry(
			{
				env: { ANTHROPIC_API_KEY: 'secret-value' },
				fetch: async (_url, init) => {
					headers = init.headers
					return Response.json(completion)
				},
			},
			deployment,
		)

		const created = registry.create('local')
		if (created.kind !== 'ok') throw new Error(created.message)
		await created.value.chat(request)

		expect(headers).toEqual({ 'content-type': 'application/json' })
	})

	test('refuses an unknown provider by name', () => {
		const registry = createProviderRegistry({ env: {}, fetch: async () => new Response() }, deployment)
		const created = registry.create('ghost')
		expect(created.kind).toBe('failed')
		if (created.kind === 'failed') expect(created.message).toContain('no provider named "ghost"')
	})

	test('refuses a provider whose credential is not in the environment', () => {
		const registry = createProviderRegistry({ env: {}, fetch: async () => new Response() }, deployment)
		const created = registry.create('anthropic')
		expect(created.kind).toBe('failed')
		if (created.kind === 'failed') expect(created.message).toContain('ANTHROPIC_API_KEY')
	})

	test('builds each provider once and reuses it', () => {
		const registry = createProviderRegistry({ env: {}, fetch: async () => new Response() }, deployment)
		const first = registry.create('local')
		const second = registry.create('local')
		if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('expected both to resolve')
		expect(first.value).toBe(second.value)
	})

	test('reports the provider names it knows', () => {
		const registry = createProviderRegistry({ env: {}, fetch: async () => new Response() }, deployment)
		expect(registry.names()).toEqual(['anthropic', 'local'])
		expect(registry.has('local')).toBe(true)
		expect(registry.has('ghost')).toBe(false)
	})
})
