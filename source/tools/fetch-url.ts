/**
 * `fetch_url` — the one tool that reaches the network.
 *
 * Network access is denied by default and granted per host in the Blueprint, so
 * a subverted model cannot read the workspace and post it somewhere. The
 * allowlist is checked here, before the request is made: a denied host is a
 * decision, never a connection that happened to fail.
 */

import { describeError } from '../errors.ts'
import type { FetchLike } from '../model/openai.ts'
import { invalidArguments } from './arguments.ts'
import type { ToolHandler, ToolResult } from './types.ts'

const MAX_BODY_CHARS = 100_000

export interface FetchToolDependencies {
	readonly fetch: FetchLike
	/** Hosts the run may reach. Empty means no egress at all. */
	readonly allowedHosts: readonly string[]
}

/** An exact host, or a `*.example.com` pattern that also covers the bare domain. */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
	const candidate = host.toLowerCase()
	for (const entry of allowedHosts) {
		const pattern = entry.toLowerCase().trim()
		if (pattern === candidate) return true
		if (pattern.startsWith('*.')) {
			const suffix = pattern.slice(1)
			if (candidate.endsWith(suffix) || candidate === pattern.slice(2)) return true
		}
	}
	return false
}

export function createFetchToolHandlers(dependencies: FetchToolDependencies): readonly ToolHandler[] {
	return [
		{
			name: 'fetch_url',
			async run(args): Promise<ToolResult> {
				const requested = args['url']
				if (typeof requested !== 'string' || requested === '') return invalidArguments('url must be a non-empty string')

				let url: URL
				try {
					url = new URL(requested)
				} catch {
					return invalidArguments(`"${requested}" is not a URL`)
				}
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					return invalidArguments(`"${url.protocol}" is not a supported scheme`)
				}

				if (!isHostAllowed(url.hostname, dependencies.allowedHosts)) {
					const permitted = dependencies.allowedHosts.length === 0 ? 'none' : dependencies.allowedHosts.join(', ')
					return {
						kind: 'permission_denied',
						message: `the run may not reach "${url.hostname}"; the egress allowlist is: ${permitted}`,
					}
				}

				let response: Response
				try {
					response = await dependencies.fetch(requested, { method: 'GET' })
				} catch (error) {
					// A network failure is a condition, not a fault.
					return { kind: 'unavailable', message: describeError(error) }
				}

				let body: string
				try {
					body = await response.text()
				} catch (error) {
					return { kind: 'unavailable', message: `the response body could not be read: ${describeError(error)}` }
				}

				return {
					kind: 'success',
					data: {
						url: requested,
						status: response.status,
						body: body.slice(0, MAX_BODY_CHARS),
						truncated: body.length > MAX_BODY_CHARS,
					},
				}
			},
		},
	]
}
