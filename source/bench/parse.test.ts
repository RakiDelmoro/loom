import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { parseBenchmarkSpec, parseSuiteConfig } from './parse.ts'

const valid = {
	id: 'fix_off_by_one',
	taskType: 'bugfix',
	difficulty: 'easy',
	task: 'Fix the range function.',
	validation: {
		command: 'bun test',
		expectedExitCode: 0,
		expectedFiles: ['src/range.ts'],
		expectedStdoutContains: ['2 pass'],
		timeoutSeconds: 60,
	},
}

function captureValidationError(subject: () => unknown): ValidationError {
	try {
		subject()
	} catch (error) {
		if (error instanceof ValidationError) return error
		throw error
	}
	throw new Error('expected a ValidationError, but nothing was thrown')
}

describe('parseBenchmarkSpec', () => {
	test('parses a full spec', () => {
		const spec = parseBenchmarkSpec(valid, 'spec.json')
		expect(spec.id).toBe('fix_off_by_one')
		expect(spec.taskType).toBe('bugfix')
		expect(spec.difficulty).toBe('easy')
		expect(spec.validation).toEqual(valid.validation)
	})

	test('fills in the optional validation expectations', () => {
		const spec = parseBenchmarkSpec({ ...valid, validation: { command: 'bun test' } }, 'spec.json')
		expect(spec.validation).toEqual({
			command: 'bun test',
			expectedExitCode: 0,
			expectedFiles: [],
			expectedStdoutContains: [],
			timeoutSeconds: 120,
		})
	})

	test('refuses a judge, which the Bench no longer has', () => {
		// Removed deliberately. The reference scores with a command, an exit code,
		// and a stdout substring, and a second grading layer is a liability its own
		// docs called one. A spec that still declares one is refused, not ignored.
		const failed = captureValidationError(() => parseBenchmarkSpec({ ...valid, judge: { rubric: 'x' } }, 'spec.json'))
		expect(failed.path).toBe('spec.json.judge')
	})

	test('rejects an unknown key and names its path', () => {
		expect(captureValidationError(() => parseBenchmarkSpec({ ...valid, difficulty2: 'easy' }, 'spec.json')).path).toBe(
			'spec.json.difficulty2',
		)
	})

	test('rejects a difficulty outside the three tiers', () => {
		expect(captureValidationError(() => parseBenchmarkSpec({ ...valid, difficulty: 'trivial' }, 'spec.json')).path).toBe(
			'spec.json.difficulty',
		)
	})

	test('rejects a spec with no validation command', () => {
		expect(captureValidationError(() => parseBenchmarkSpec({ ...valid, validation: {} }, 'spec.json')).path).toBe(
			'spec.json.validation.command',
		)
	})

	test('rejects an unknown key nested inside validation', () => {
		const broken = { ...valid, validation: { ...valid.validation, expectExitCode: 0 } }
		expect(captureValidationError(() => parseBenchmarkSpec(broken, 'spec.json')).path).toBe(
			'spec.json.validation.expectExitCode',
		)
	})

	test('rejects a non-integer expected exit code', () => {
		const broken = { ...valid, validation: { ...valid.validation, expectedExitCode: 'zero' } }
		expect(captureValidationError(() => parseBenchmarkSpec(broken, 'spec.json')).path).toBe(
			'spec.json.validation.expectedExitCode',
		)
	})
})

describe('parseSuiteConfig', () => {
	test('parses the two splits', () => {
		expect(parseSuiteConfig({ optimization: ['a'], heldOut: ['b'] }, 'suite.json')).toEqual({
			optimization: ['a'],
			heldOut: ['b'],
		})
	})

	test('refuses a suite that configures a judge', () => {
		const failed = captureValidationError(() =>
			parseSuiteConfig({ optimization: [], heldOut: [], judge: {} }, 'suite.json'),
		)
		expect(failed.path).toBe('suite.json.judge')
	})

	test('rejects an unknown key', () => {
		expect(captureValidationError(() => parseSuiteConfig({ optimization: [], heldOut: [], split: 'x' }, 'suite.json')).path).toBe(
			'suite.json.split',
		)
	})
})
