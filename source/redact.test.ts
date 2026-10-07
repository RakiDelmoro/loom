import { describe, expect, test } from 'bun:test'
import { createRedactor, noRedaction, REDACTION_PLACEHOLDER } from './redact.ts'

const SECRET = 'sk-live-0123456789abcdef'

describe('createRedactor', () => {
	test('replaces a secret wherever it appears', () => {
		const redact = createRedactor([SECRET])
		expect(redact(`the key is ${SECRET}, keep it`)).toBe(`the key is ${REDACTION_PLACEHOLDER}, keep it`)
	})

	test('replaces every occurrence', () => {
		const redact = createRedactor([SECRET])
		expect(redact(`${SECRET} and ${SECRET}`)).toBe(`${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}`)
	})

	test('replaces every distinct secret', () => {
		const redact = createRedactor([SECRET, 'another-long-secret'])
		expect(redact(`${SECRET} / another-long-secret`)).toBe(`${REDACTION_PLACEHOLDER} / ${REDACTION_PLACEHOLDER}`)
	})

	test('leaves ordinary text alone', () => {
		const redact = createRedactor([SECRET])
		expect(redact('nothing to see here')).toBe('nothing to see here')
	})

	test('ignores a "secret" too short to be one, rather than corrupting the text', () => {
		// Redacting a two-character value would shred the log.
		expect(createRedactor(['ab'])('about the abacus')).toBe('about the abacus')
	})

	test('an empty set changes nothing', () => {
		expect(createRedactor([])('anything')).toBe('anything')
	})

	test('redacting twice is harmless', () => {
		const redact = createRedactor([SECRET])
		expect(redact(redact(SECRET))).toBe(REDACTION_PLACEHOLDER)
	})
})

describe('noRedaction', () => {
	test('is the identity', () => {
		expect(noRedaction(SECRET)).toBe(SECRET)
	})
})
