import { describe, expect, test } from 'bun:test'
import { collectSecrets } from './secrets.ts'
import type { Deployment } from './types.ts'

const deployment: Deployment = {
	providers: {
		local: { baseUrl: 'http://localhost:8080/v1' },
		cloud: { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'CLOUD_KEY' },
		other: { baseUrl: 'https://other.example.com/v1', apiKeyEnv: 'OTHER_KEY' },
	},
	prices: {},
}

describe('collectSecrets', () => {
	test('collects the values behind every named variable', () => {
		const secrets = collectSecrets(deployment, { CLOUD_KEY: 'sk-cloud', OTHER_KEY: 'sk-other' })
		expect(secrets.sort()).toEqual(['sk-cloud', 'sk-other'])
	})

	test('collects nothing for a provider that names no credential', () => {
		expect(collectSecrets(deployment, {})).toEqual([])
	})

	test('skips a variable that is named but unset', () => {
		expect(collectSecrets(deployment, { CLOUD_KEY: 'sk-cloud' })).toEqual(['sk-cloud'])
	})

	test('skips an empty value', () => {
		expect(collectSecrets(deployment, { CLOUD_KEY: '' })).toEqual([])
	})

	test('does not repeat a value shared by two providers', () => {
		expect(collectSecrets(deployment, { CLOUD_KEY: 'same', OTHER_KEY: 'same' })).toEqual(['same'])
	})
})
