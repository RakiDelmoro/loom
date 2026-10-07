import { describe, expect, test } from 'bun:test'
import { createToolRegistry } from './registry.ts'
import { createFetchToolHandlers, isHostAllowed } from './fetch-url.ts'
import type { ToolHandler, ToolResult } from './types.ts'

const context = { workspaceRoot: '/repo' }

describe('isHostAllowed', () => {
	test('matches an exact host, case-insensitively', () => {
		expect(isHostAllowed('example.com', ['example.com'])).toBe(true)
		expect(isHostAllowed('EXAMPLE.com', ['example.com'])).toBe(true)
	})

	test('matches a wildcard suffix and the bare domain', () => {
		expect(isHostAllowed('api.example.com', ['*.example.com'])).toBe(true)
		expect(isHostAllowed('example.com', ['*.example.com'])).toBe(true)
		expect(isHostAllowed('deep.api.example.com', ['*.example.com'])).toBe(true)
	})

	test('does not match a lookalike domain', () => {
		expect(isHostAllowed('notexample.com', ['example.com'])).toBe(false)
		expect(isHostAllowed('example.com.evil.test', ['*.example.com'])).toBe(false)
	})

	test('an empty allowlist permits nothing', () => {
		expect(isHostAllowed('example.com', [])).toBe(false)
	})
})

function createFetch(files: Readonly<Record<string, string>>, allowedHosts: readonly string[]) {
	const requested: string[] = []
	const handlers: readonly ToolHandler[] = createFetchToolHandlers({
		allowedHosts,
		fetch: async (url) => {
			requested.push(url)
			const body = files[url]
			if (body === undefined) return new Response('not found', { status: 404 })
			return new Response(body, { status: 200 })
		},
	})
	return { registry: createToolRegistry(handlers), requested }
}

describe('fetch_url', () => {
	test('fetches an allowed host', async () => {
		const { registry, requested } = createFetch({ 'https://example.com/a': 'hello' }, ['example.com'])
		const result = await registry.run('fetch_url', { url: 'https://example.com/a' }, context)

		expect(result.kind).toBe('success')
		expect(requested).toEqual(['https://example.com/a'])
	})

	test('refuses a host that is not on the allowlist, and never makes the request', async () => {
		const { registry, requested } = createFetch({ 'https://elsewhere.test/a': 'hello' }, ['example.com'])
		const result = await registry.run('fetch_url', { url: 'https://elsewhere.test/a' }, context)

		expect(result.kind).toBe('permission_denied')
		// Asserted, not assumed: the connection was never attempted.
		expect(requested).toEqual([])
	})

	test('an empty allowlist refuses everything', async () => {
		const { registry, requested } = createFetch({ 'https://example.com/a': 'hello' }, [])
		expect((await registry.run('fetch_url', { url: 'https://example.com/a' }, context)).kind).toBe('permission_denied')
		expect(requested).toEqual([])
	})

	test('refuses a scheme that is not http or https', async () => {
		const { registry } = createFetch({}, ['example.com'])
		expect((await registry.run('fetch_url', { url: 'file:///etc/passwd' }, context)).kind).toBe('invalid_arguments')
	})

	test('rejects a value that is not a URL', async () => {
		const { registry } = createFetch({}, ['example.com'])
		expect((await registry.run('fetch_url', { url: 'not a url' }, context)).kind).toBe('invalid_arguments')
	})

	test('reports a network failure rather than throwing', async () => {
		const registry = createToolRegistry(
			createFetchToolHandlers({
				allowedHosts: ['example.com'],
				fetch: async () => {
					throw new Error('connection refused')
				},
			}),
		)
		const result: ToolResult = await registry.run('fetch_url', { url: 'https://example.com/a' }, context)
		expect(result.kind).toBe('unavailable')
	})

	test('truncates a large body and says so', async () => {
		const big = 'x'.repeat(200_000)
		const { registry } = createFetch({ 'https://example.com/big': big }, ['example.com'])
		const result = await registry.run('fetch_url', { url: 'https://example.com/big' }, context)
		if (result.kind !== 'success') throw new Error(result.message)
		// The payload is a tool result, so its shape is checked rather than cast.
		expect(JSON.stringify(result.data)).toContain('"truncated":true')
	})
})
