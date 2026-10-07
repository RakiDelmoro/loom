import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { isSafeChangePath, parseHypotheses } from './hypothesis.ts'

const valid = [
	{
		id: 'h-001',
		motivation: 'the coder stops after the first failing test',
		mechanism: 'add an iterate-until-green instruction to the coder prompt',
		predictedImpact: '+10% on bugfix tasks',
		changes: [{ path: 'prompts/coder.md', content: 'You iterate until green.\n' }],
	},
]

function captureValidationError(subject: () => unknown): ValidationError {
	try {
		subject()
	} catch (error) {
		if (error instanceof ValidationError) return error
		throw error
	}
	throw new Error('expected a ValidationError, but nothing was thrown')
}

describe('isSafeChangePath', () => {
	test('accepts a path inside the guild directory', () => {
		expect(isSafeChangePath('prompts/coder.md')).toBe(true)
		expect(isSafeChangePath('loom.json')).toBe(true)
	})

	test('rejects an absolute path', () => {
		expect(isSafeChangePath('/etc/passwd')).toBe(false)
		expect(isSafeChangePath('C:\\Windows')).toBe(false)
	})

	test('rejects a path that climbs out', () => {
		expect(isSafeChangePath('../secrets.md')).toBe(false)
		expect(isSafeChangePath('prompts/../../outside.md')).toBe(false)
	})

	test('rejects an empty path', () => {
		expect(isSafeChangePath('')).toBe(false)
	})
})

describe('parseHypotheses', () => {
	test('parses a well-formed set', () => {
		expect(parseHypotheses(valid)[0]?.changes[0]?.path).toBe('prompts/coder.md')
	})

	test('rejects a reply that is not an array', () => {
		expect(captureValidationError(() => parseHypotheses({ id: 'h' })).path).toBe('hypotheses')
	})

	test('rejects an unknown key and names its path', () => {
		const broken = [{ ...valid[0], confidence: 0.9 }]
		expect(captureValidationError(() => parseHypotheses(broken)).path).toBe('hypotheses[0].confidence')
	})

	test('rejects a missing motivation', () => {
		const { motivation: _dropped, ...rest } = valid[0] ?? {}
		expect(captureValidationError(() => parseHypotheses([rest])).path).toBe('hypotheses[0].motivation')
	})

	test('rejects a hypothesis that changes nothing', () => {
		expect(captureValidationError(() => parseHypotheses([{ ...valid[0], changes: [] }])).path).toBe('hypotheses[0].changes')
	})

	test('rejects an edit outside the guild directory', () => {
		const broken = [{ ...valid[0], changes: [{ path: '../escape.md', content: 'x' }] }]
		const error = captureValidationError(() => parseHypotheses(broken))
		expect(error.path).toBe('hypotheses[0].changes[0].path')
		expect(error.message).toContain('not a path inside the guild directory')
	})

	test('rejects an empty file body', () => {
		const broken = [{ ...valid[0], changes: [{ path: 'prompts/coder.md', content: '' }] }]
		expect(captureValidationError(() => parseHypotheses(broken)).path).toBe('hypotheses[0].changes[0].content')
	})
})
