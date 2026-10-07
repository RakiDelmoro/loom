import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { loadDeployment } from './load.ts'
import { parseDeployment } from './parse.ts'

const valid = {
	providers: {
		local: { baseUrl: 'http://localhost:8080/v1' },
		anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' },
	},
	prices: {
		'qwen3-coder-30b': { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 },
		'claude-sonnet-4': { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 },
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

describe('parseDeployment', () => {
	test('parses a valid deployment file', () => {
		expect(parseDeployment(valid)).toEqual(valid)
	})

	test('treats a provider with no apiKeyEnv as needing no credential', () => {
		expect(parseDeployment(valid).providers['local']?.apiKeyEnv).toBeUndefined()
	})

	test('rejects an unknown key and names its path', () => {
		const broken = { ...valid, price: {} }
		expect(captureValidationError(() => parseDeployment(broken)).path).toBe('deployment.price')
	})

	test('rejects an unknown key nested in a provider', () => {
		const broken = { ...valid, providers: { local: { baseUrl: 'http://x', apiKey: 'oops' } } }
		expect(captureValidationError(() => parseDeployment(broken)).path).toBe('deployment.providers.local.apiKey')
	})

	test('rejects a provider with no baseUrl', () => {
		const broken = { ...valid, providers: { local: { apiKeyEnv: 'K' } } }
		expect(captureValidationError(() => parseDeployment(broken)).path).toBe('deployment.providers.local.baseUrl')
	})

	test('rejects a negative price', () => {
		const broken = { ...valid, prices: { m: { inputPer1M: -1, cachedInputPer1M: 0, outputPer1M: 0 } } }
		expect(captureValidationError(() => parseDeployment(broken)).path).toBe('deployment.prices.m.inputPer1M')
	})

	test('rejects a price missing a field', () => {
		const broken = { ...valid, prices: { m: { inputPer1M: 1, outputPer1M: 1 } } }
		expect(captureValidationError(() => parseDeployment(broken)).path).toBe('deployment.prices.m.cachedInputPer1M')
	})
})

describe('loadDeployment', () => {
	test('reads and parses a deployment file', () => {
		const deployment = loadDeployment(
			{ readTextFile: () => ({ kind: 'ok', text: JSON.stringify(valid) }) },
			'/repo/loom.deployment.json',
		)
		expect(deployment.providers['anthropic']?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
	})

	test('reports a missing file by path', () => {
		const error = captureValidationError(() =>
			loadDeployment({ readTextFile: () => ({ kind: 'unreadable', message: 'file does not exist' }) }, '/repo/x.json'),
		)
		expect(error.path).toBe('/repo/x.json')
	})

	test('reports malformed JSON by path', () => {
		const error = captureValidationError(() =>
			loadDeployment({ readTextFile: () => ({ kind: 'ok', text: '{ not json' }) }, '/repo/x.json'),
		)
		expect(error.message).toContain('not valid JSON')
	})
})
