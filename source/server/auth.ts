/**
 * Request authorization.
 *
 * A token is a bearer credential on every request, not a session: the service
 * holds no state about who is asking, so there is nothing to expire and nothing
 * to revoke. A null token disables the check, which is a deliberate opt-in for a
 * service bound to localhost and nothing else.
 */

export type AuthResult = { readonly kind: 'ok' } | { readonly kind: 'denied'; readonly reason: string }

/** The token from an `Authorization: Bearer <token>` header, when it is present and well-formed. */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization')
	if (header === null) return null
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
	return match?.[1] ?? null
}

export function authorize(request: Request, token: string | null): AuthResult {
	if (token === null) return { kind: 'ok' }
	const presented = bearerToken(request)
	if (presented === null) return { kind: 'denied', reason: 'missing bearer token' }
	if (presented !== token) return { kind: 'denied', reason: 'the bearer token does not match' }
	return { kind: 'ok' }
}
