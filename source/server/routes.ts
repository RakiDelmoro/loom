/**
 * The HTTP surface's routing and translation.
 *
 * Every handler is a pure function of its request and the service, so the whole
 * API is testable without a socket. The transport in `server.ts` does the I/O:
 * it parses a URL, reads a body, calls this, and serializes the answer.
 *
 * Errors are values here, as everywhere else: a refusal is a status and a
 * message, never a thrown exception crossing the wire.
 */

import { isRecord } from '../guards.ts'
import type { ModelPrice } from '../deployment/types.ts'
import type { AutonomyLevel } from '../runs/types.ts'
import type { RunService } from './service.ts'
import { buildTrace } from './trace.ts'

export interface ApiRequest {
	readonly method: string
	readonly pathname: string
	readonly query: URLSearchParams
	readonly body: unknown
}

export interface ApiResponse {
	readonly status: number
	readonly body: unknown
}

export interface BenchStatus {
	readonly running: boolean
	/** The most recent completed suite result, or null while none has finished. */
	readonly last: unknown
}

export interface RouteDependencies {
	readonly service: RunService
	readonly prices: Readonly<Record<string, ModelPrice>>
	/** Default autonomy for a submitted run. */
	readonly defaultAutonomy: AutonomyLevel
	/** Starts a suite run in the background. Null when the host cannot run one. */
	readonly startBench: ((split: string) => { readonly kind: 'ok' } | { readonly kind: 'failed'; readonly message: string }) | null
	/** The bench's progress, for polling. Null when the host cannot run one. */
	readonly benchStatus: (() => BenchStatus) | null
}

function json(status: number, body: unknown): ApiResponse {
	return { status, body }
}

function failure(status: number, message: string): ApiResponse {
	return { status, body: { error: message } }
}

function readString(body: unknown, key: string): string | null {
	if (!isRecord(body)) return null
	const value = body[key]
	return typeof value === 'string' ? value : null
}

function benchRoute(request: ApiRequest, dependencies: RouteDependencies): ApiResponse {
	if (dependencies.startBench === null || dependencies.benchStatus === null) {
		return failure(501, 'this server was not started with a suite to run')
	}
	if (request.method === 'GET') return json(200, dependencies.benchStatus())
	if (request.method === 'POST') {
		const split = readString(request.body, 'split') ?? 'held-out'
		if (split !== 'held-out' && split !== 'optimization') {
			return failure(400, 'split must be "held-out" or "optimization"')
		}
		const started = dependencies.startBench(split)
		if (started.kind !== 'ok') return failure(409, started.message)
		return json(202, { started: true, split })
	}
	return failure(405, `${request.method} is not allowed on /api/bench`)
}

function readAutonomy(body: unknown, fallback: AutonomyLevel): AutonomyLevel {
	const value = readString(body, 'autonomy')
	return value === 'manual' || value === 'auto' || value === 'supervised' ? value : fallback
}

/**
 * Routes a request. An unknown path is a 404 with the reason, so a caller that
 * mistypes an endpoint is told so rather than silently receiving nothing.
 */
export function handleApi(request: ApiRequest, dependencies: RouteDependencies): ApiResponse {
	const { service } = dependencies
	const segments = request.pathname.split('/').filter((segment) => segment !== '')

	if (segments[0] !== 'api') return failure(404, `no route for ${request.pathname}`)

	// /api/health
	if (segments.length === 2 && segments[1] === 'health') {
		return json(200, { ok: true, activeRunId: service.active() })
	}

	// /api/bench — start a suite run, or read its progress.
	if (segments.length === 2 && segments[1] === 'bench') {
		return benchRoute(request, dependencies)
	}

	if (segments[1] !== 'runs') return failure(404, `no route for ${request.pathname}`)

	// /api/runs
	if (segments.length === 2) {
		if (request.method === 'GET') {
			return json(200, {
				activeRunId: service.active(),
				runs: service.list().map((manifest) => ({
					runId: manifest.runId,
					task: manifest.task,
					status: manifest.status,
					autonomy: manifest.autonomy,
					baseSha: manifest.baseSha,
					startedAt: manifest.startedAt,
					finishedAt: manifest.finishedAt,
					costUsd: manifest.costUsd,
					agents: manifest.agents.length,
				})),
			})
		}
		if (request.method === 'POST') {
			const task = readString(request.body, 'task')
			if (task === null) return failure(400, 'the request needs a "task" string')
			const submitted = service.submit({ task, autonomy: readAutonomy(request.body, dependencies.defaultAutonomy) })
			if (submitted.kind !== 'ok') return failure(409, submitted.message)
			return json(202, submitted.value)
		}
		return failure(405, `${request.method} is not allowed on ${request.pathname}`)
	}

	const runId = decodeURIComponent(segments[2] ?? '')
	const manifest = service.manifest(runId)

	// /api/runs/:id
	if (segments.length === 3) {
		if (request.method !== 'GET') return failure(405, `${request.method} is not allowed on ${request.pathname}`)
		if (manifest === null) return failure(404, `no run "${runId}"`)
		const control = service.control(runId)
		return json(200, { manifest, running: control !== null, paused: control?.paused ?? false })
	}

	const action = segments[3] ?? ''
	const isReadAction = action === 'events' || action === 'diff' || action === 'trace'

	// The read actions work on a finished run, so they only need the manifest —
	// but the method is still checked first, so a write to a read route is refused
	// rather than mistaken for an unknown one.
	if (isReadAction) {
		if (request.method !== 'GET') return failure(405, `${request.method} is not allowed on ${request.pathname}`)
		if (manifest === null) return failure(404, `no run "${runId}"`)

		if (action === 'events') {
			const offset = Math.max(0, Number.parseInt(request.query.get('offset') ?? '0', 10) || 0)
			const limit = Math.min(5000, Math.max(1, Number.parseInt(request.query.get('limit') ?? '1000', 10) || 1000))
			const all = service.events(runId)
			return json(200, { total: all.length, offset, events: all.slice(offset, offset + limit) })
		}

		if (action === 'diff') {
			const agentId = request.query.get('agent')
			const diff = service.diff(runId, agentId === null || agentId === '' ? null : agentId)
			if (diff.kind !== 'ok') return failure(409, diff.message)
			return json(200, { diff: diff.value })
		}

		return json(200, { spans: buildTrace(service.events(runId), dependencies.prices) })
	}

	if (request.method !== 'POST') return failure(405, `${request.method} is not allowed on ${request.pathname}`)

	if (action === 'merge') {
		const agentId = readString(request.body, 'agentId')
		if (agentId === null) return failure(400, 'merge needs an "agentId"')
		const merged = service.merge(runId, agentId)
		if (merged.kind !== 'ok') return failure(409, merged.message)
		return json(200, { merged: merged.value })
	}

	if (action === 'undo') {
		const undone = service.undo(runId)
		if (undone.kind !== 'ok') return failure(409, undone.message)
		return json(200, { baseSha: undone.value })
	}

	// Control acts on the run that is going, so it needs the live control.
	const control = service.control(runId)
	if (action === 'steer' || action === 'pause' || action === 'resume') {
		if (control === null) {
			return failure(409, manifest === null ? `no run "${runId}"` : `run "${runId}" is not the one in progress`)
		}
		if (action === 'steer') {
			const message = readString(request.body, 'message')
			if (message === null || message.trim() === '') return failure(400, 'steer needs a non-empty "message"')
			control.steer(message)
			return json(202, { queued: message, paused: control.paused })
		}
		if (action === 'pause') {
			control.pause()
			return json(200, { paused: true })
		}
		control.resume()
		return json(200, { paused: false })
	}

	return failure(404, `no route for ${request.pathname}`)
}
