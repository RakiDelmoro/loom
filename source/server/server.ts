/**
 * The transport: a Bun HTTP server over the API routes and the static UI.
 *
 * The static assets are served without a token — the page is not secret, and a
 * browser has no way to present a bearer token before it loads one. Everything
 * under `/api/` requires it, so the data is what is protected, not the HTML that
 * asks for it.
 */

import * as path from 'node:path'
import { ValidationError } from '../errors.ts'
import type { FileSystem } from '../fs.ts'
import { isRecord } from '../guards.ts'
import { authorize } from './auth.ts'
import type { RouteDependencies } from './routes.ts'
import { handleApi } from './routes.ts'

export interface ServerDependencies {
	readonly routes: RouteDependencies
	readonly fs: FileSystem
	/** Directory holding `index.html`, `app.js`, and `styles.css`. */
	readonly staticRoot: string
	/** A bearer token every API call must present, or null to serve unauthenticated. */
	readonly token: string | null
	readonly log: (message: string) => void
}

export interface ServerHandle {
	readonly port: number
	readonly url: string
	stop(): Promise<void>
}

const STATIC_FILES: Readonly<Record<string, { readonly file: string; readonly type: string }>> = {
	'/': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
	'/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
}

async function readBody(request: Request): Promise<unknown> {
	const text = await request.text()
	if (text.trim() === '') return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

export async function startServer(
	dependencies: ServerDependencies,
	options: { readonly port: number; readonly hostname: string },
): Promise<ServerHandle> {
	let server: ReturnType<typeof Bun.serve>
	try {
		server = Bun.serve({
			port: options.port,
			hostname: options.hostname,
			fetch: async (request: Request): Promise<Response> => {
				const url = new URL(request.url)

				if (!url.pathname.startsWith('/api/')) {
					const asset = STATIC_FILES[url.pathname]
					if (asset === undefined) return new Response('not found', { status: 404 })
					const file = dependencies.fs.readTextFile(path.join(dependencies.staticRoot, asset.file))
					if (file.kind !== 'ok') return new Response(`the UI asset is missing: ${asset.file}`, { status: 500 })
					return new Response(file.text, { headers: { 'content-type': asset.type } })
				}

				const permitted = authorize(request, dependencies.token)
				if (permitted.kind !== 'ok') return Response.json({ error: permitted.reason }, { status: 401 })

				const body = request.method === 'POST' ? await readBody(request) : null
				const response = handleApi(
					{ method: request.method, pathname: url.pathname, query: url.searchParams, body },
					dependencies.routes,
				)
				return Response.json(response.body, { status: response.status })
			},
		})
	} catch (error) {
		// A port already taken is an ordinary configuration mistake, not a crash,
		// and the operator deserves the sentence rather than the stack trace.
		if (isRecord(error) && error['code'] === 'EADDRINUSE') {
			throw new ValidationError(
				'--port',
				`${String(options.port)} is already in use; choose another, or stop what is listening on it`,
			)
		}
		throw error
	}

	return {
		port: server.port ?? options.port,
		url: `http://${options.hostname}:${String(server.port ?? options.port)}`,
		stop: async (): Promise<void> => {
			await server.stop(true)
		},
	}
}

/** Where the static UI lives, resolved from this module rather than the cwd. */
export function defaultStaticRoot(): string {
	return path.join(path.dirname(new URL(import.meta.url).pathname), 'static')
}
