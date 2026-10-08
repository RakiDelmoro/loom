import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import type { FileSystem } from '../fs.ts'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createFakeRunService } from '../test-support/service.ts'
import { startServer, type ServerDependencies } from './server.ts'

function dependencies(overrides: { readonly fs?: FileSystem; readonly token?: string | null } = {}): ServerDependencies {
	return {
		routes: { service: createFakeRunService(), prices: {}, defaultAutonomy: 'auto', startBench: null, benchStatus: null },
		fs: overrides.fs ?? createMemoryFileSystem().fs,
		staticRoot: '/ui',
		token: overrides.token ?? null,
		log: () => {},
	}
}

/** A server on an ephemeral port, stopped when the test is done. */
async function withServer<T>(deps: ServerDependencies, body: (url: string) => Promise<T>): Promise<T> {
	const server = await startServer(deps, { port: 0, hostname: '127.0.0.1' })
	try {
		return await body(server.url)
	} finally {
		await server.stop()
	}
}

describe('the HTTP transport', () => {
	test('a port already in use is a configuration error, not a crash', async () => {
		const first = await startServer(dependencies(), { port: 0, hostname: '127.0.0.1' })
		try {
			// The operator gets a sentence they can act on, not a stack trace.
			await expect(startServer(dependencies(), { port: first.port, hostname: '127.0.0.1' })).rejects.toThrow(ValidationError)
		} finally {
			await first.stop()
		}
	})

	test('an unknown static path is a 404 and the UI is served verbatim', async () => {
		const fs = createMemoryFileSystem({ '/ui/index.html': '<html>loom</html>' }).fs

		await withServer(dependencies({ fs }), async (url) => {
			const page = await fetch(`${url}/`)
			expect(page.status).toBe(200)
			expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
			expect(await page.text()).toBe('<html>loom</html>')
			expect((await fetch(`${url}/nope`)).status).toBe(404)
		})
	})

	test('the API is routed over the wire, not treated as a static file', async () => {
		await withServer(dependencies(), async (url) => {
			const response = await fetch(`${url}/api/health`)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ ok: true, activeRunId: null })
		})
	})

	test('a missing API asset is a 500 that names the file', async () => {
		await withServer(dependencies(), async (url) => {
			const response = await fetch(`${url}/app.js`)
			expect(response.status).toBe(500)
			expect(await response.text()).toContain('app.js')
		})
	})

	test('a token protects /api but not the page that asks for it', async () => {
		const fs = createMemoryFileSystem({ '/ui/index.html': '<html>loom</html>' }).fs

		await withServer(dependencies({ fs, token: 'secret' }), async (url) => {
			// The page cannot carry a credential before it has loaded one.
			expect((await fetch(`${url}/`)).status).toBe(200)

			expect((await fetch(`${url}/api/health`)).status).toBe(401)
			const wrong = await fetch(`${url}/api/health`, { headers: { authorization: 'Bearer nope' } })
			expect(wrong.status).toBe(401)
			expect(await wrong.json()).toEqual({ error: 'the bearer token does not match' })

			const right = await fetch(`${url}/api/health`, { headers: { authorization: 'Bearer secret' } })
			expect(right.status).toBe(200)
		})
	})

	test('a run is started over the wire and answers before it happens', async () => {
		const service = createFakeRunService()
		const deps: ServerDependencies = { ...dependencies(), routes: { service, prices: {}, defaultAutonomy: 'auto', startBench: null, benchStatus: null } }

		await withServer(deps, async (url) => {
			const response = await fetch(`${url}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ task: 'add a flag' }),
			})
			expect(response.status).toBe(202)
			expect(await response.json()).toEqual({ runId: 'run-1' })
			expect(service.submitted).toEqual([{ task: 'add a flag', autonomy: 'auto' }])
		})
	})

	test('a malformed body is a 400, not a thrown parse error', async () => {
		await withServer(dependencies(), async (url) => {
			const response = await fetch(`${url}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: 'this is not json',
			})
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'the request needs a "task" string' })
		})
	})
})
