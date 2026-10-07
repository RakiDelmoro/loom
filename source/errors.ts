/**
 * A validation failure that carries the JSON path of the offending value.
 *
 * Every rejection of external data (a Blueprint, a tool manifest, a provider
 * response) reports *where* it is wrong, not only *that* it is wrong — a config
 * typo must be fixable without a debugger.
 */
export class ValidationError extends Error {
	readonly path: string

	constructor(path: string, message: string) {
		super(`${path}: ${message}`)
		this.name = 'ValidationError'
		this.path = path
	}
}

/** Best-effort human-readable description of an unknown thrown value. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}
