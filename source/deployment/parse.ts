/**
 * Strict parsing for the deployment file.
 *
 * The file is small and fully known, so unknown keys are rejected at every level
 * — a typo in `apiKeyEnv` must fail loudly rather than silently leaving a
 * provider unauthenticated.
 */

import type { Deployment, ModelPrice, ProviderConfig } from './types.ts'
import { expectNonEmptyString, expectNonNegativeNumber, expectRecord, rejectUnknownKeys } from '../validation.ts'

const DEPLOYMENT_KEYS = ['providers', 'prices'] as const
const PROVIDER_KEYS = ['baseUrl', 'apiKeyEnv'] as const
const PRICE_KEYS = ['inputPer1M', 'cachedInputPer1M', 'outputPer1M'] as const

function parseProvider(value: unknown, path: string): ProviderConfig {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, PROVIDER_KEYS, path)
	return {
		baseUrl: expectNonEmptyString(record['baseUrl'], `${path}.baseUrl`),
		...(record['apiKeyEnv'] !== undefined
			? { apiKeyEnv: expectNonEmptyString(record['apiKeyEnv'], `${path}.apiKeyEnv`) }
			: {}),
	}
}

function parsePrice(value: unknown, path: string): ModelPrice {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, PRICE_KEYS, path)
	return {
		inputPer1M: expectNonNegativeNumber(record['inputPer1M'], `${path}.inputPer1M`),
		cachedInputPer1M: expectNonNegativeNumber(record['cachedInputPer1M'], `${path}.cachedInputPer1M`),
		outputPer1M: expectNonNegativeNumber(record['outputPer1M'], `${path}.outputPer1M`),
	}
}

export function parseDeployment(value: unknown, path = 'deployment'): Deployment {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, DEPLOYMENT_KEYS, path)

	const providersRecord = expectRecord(record['providers'], `${path}.providers`)
	const providers: Record<string, ProviderConfig> = {}
	for (const [name, providerValue] of Object.entries(providersRecord)) {
		providers[name] = parseProvider(providerValue, `${path}.providers.${name}`)
	}

	const pricesRecord = expectRecord(record['prices'], `${path}.prices`)
	const prices: Record<string, ModelPrice> = {}
	for (const [name, priceValue] of Object.entries(pricesRecord)) {
		prices[name] = parsePrice(priceValue, `${path}.prices.${name}`)
	}

	return { providers, prices }
}
