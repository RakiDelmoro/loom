/**
 * The provider registry: turns a profile's provider *name* into a live client.
 *
 * A client is built once per provider and reused, so a run does not rebuild one
 * per call. The credential is read from the environment variable the deployment
 * file names — the file never holds the key, so a leaked deployment file leaks
 * nothing.
 */

import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import type { FetchLike } from '../model/openai.ts'
import { createOpenAiCompatibleProvider } from '../model/openai.ts'
import type { Provider } from '../model/types.ts'
import type { Deployment } from './types.ts'

export interface ProviderRegistry {
	has(name: string): boolean
	names(): readonly string[]
	create(name: string): OpResult<Provider>
}

export interface ProviderRegistryDependencies {
	readonly fetch: FetchLike
	readonly env: Readonly<Record<string, string | undefined>>
}

export function createProviderRegistry(
	dependencies: ProviderRegistryDependencies,
	deployment: Deployment,
): ProviderRegistry {
	const built = new Map<string, Provider>()

	return {
		has(name: string): boolean {
			return deployment.providers[name] !== undefined
		},

		names(): readonly string[] {
			return Object.keys(deployment.providers).sort()
		},

		create(name: string): OpResult<Provider> {
			const cached = built.get(name)
			if (cached !== undefined) return ok(cached)

			const config = deployment.providers[name]
			if (config === undefined) return failed(`no provider named "${name}" in the deployment file`)

			let apiKey: string | undefined
			if (config.apiKeyEnv !== undefined) {
				const value = dependencies.env[config.apiKeyEnv]
				if (value === undefined || value === '') {
					return failed(`provider "${name}" needs environment variable ${config.apiKeyEnv}, which is not set`)
				}
				apiKey = value
			}

			const provider = createOpenAiCompatibleProvider({
				id: name,
				baseUrl: config.baseUrl,
				...(apiKey !== undefined ? { apiKey } : {}),
				fetch: dependencies.fetch,
			})
			built.set(name, provider)
			return ok(provider)
		},
	}
}
