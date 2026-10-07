/**
 * The outcome of an operation that can fail for an ordinary reason.
 *
 * A missing worktree, a dirty base tree, a branch that will not merge — these
 * are expected conditions, so they are values the caller branches on rather than
 * exceptions it has to catch.
 */

export type OpResult<T> =
	| { readonly kind: 'ok'; readonly value: T }
	| { readonly kind: 'failed'; readonly message: string }

export function ok<T>(value: T): OpResult<T> {
	return { kind: 'ok', value }
}

export function failed<T>(message: string): OpResult<T> {
	return { kind: 'failed', message }
}
