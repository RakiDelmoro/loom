import { describe, expect, test } from 'bun:test'
import { authorize, bearerToken } from './auth.ts'

function request(headers: Readonly<Record<string, string>> = {}): Request {
	return new Request('http://localhost/api/runs', { headers })
}

describe('authorization', () => {
	test('no configured token means no check', () => {
		expect(authorize(request(), null).kind).toBe('ok')
	})

	test('a configured token refuses a request with no credential', () => {
		const result = authorize(request(), 'secret')
		expect(result.kind).toBe('denied')
	})

	test('a wrong token is refused, and a right one is not', () => {
		expect(authorize(request({ authorization: 'Bearer wrong' }), 'secret').kind).toBe('denied')
		expect(authorize(request({ authorization: 'Bearer secret' }), 'secret').kind).toBe('ok')
	})

	test('the scheme is case-insensitive and tolerates surrounding space', () => {
		expect(authorize(request({ authorization: 'bearer secret' }), 'secret').kind).toBe('ok')
		expect(authorize(request({ authorization: '  Bearer   secret  ' }), 'secret').kind).toBe('ok')
	})

	test('a credential of the wrong scheme is not accepted', () => {
		expect(bearerToken(request({ authorization: 'Basic c2VjcmV0' }))).toBeNull()
		expect(authorize(request({ authorization: 'Basic c2VjcmV0' }), 'secret').kind).toBe('denied')
	})

	test('a token that merely starts the same is not accepted', () => {
		expect(authorize(request({ authorization: 'Bearer secrets' }), 'secret').kind).toBe('denied')
	})
})
