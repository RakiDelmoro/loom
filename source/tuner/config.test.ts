import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { parseTunerConfig } from './config.ts'

const valid = {
	suitePath: 'benchmarks',
	guildPath: '.',
	deploymentPath: 'loom.deployment.json',
	maxCycles: 3,
	maxCostUsd: 5,
	plateauLimit: 2,
	improvementMargin: 0.1,
	costMargin: 0.2,
	repetitions: 1,
	bigModel: { provider: 'together', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
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

describe('parseTunerConfig', () => {
	test('parses a valid config', () => {
		expect(parseTunerConfig(valid)).toEqual(valid)
	})

	test('accepts a zero cost ceiling', () => {
		expect(parseTunerConfig({ ...valid, maxCostUsd: 0 }).maxCostUsd).toBe(0)
	})

	test('accepts a zero margin', () => {
		expect(parseTunerConfig({ ...valid, improvementMargin: 0 }).improvementMargin).toBe(0)
	})

	test('rejects a margin of one or more', () => {
		expect(captureValidationError(() => parseTunerConfig({ ...valid, improvementMargin: 1 })).path).toBe(
			'tuner.json.improvementMargin',
		)
	})

	test('rejects an unknown key', () => {
		expect(captureValidationError(() => parseTunerConfig({ ...valid, maxCycles2: 1 })).path).toBe('tuner.json.maxCycles2')
	})

	test('rejects a big model with no model name', () => {
		expect(captureValidationError(() => parseTunerConfig({ ...valid, bigModel: { provider: 'x' } })).path).toBe(
			'tuner.json.bigModel.model',
		)
	})

	test('rejects a zero cycle budget', () => {
		expect(captureValidationError(() => parseTunerConfig({ ...valid, maxCycles: 0 })).path).toBe('tuner.json.maxCycles')
	})
})
