/**
 * The secrets a deployment puts into play.
 *
 * Collected so they can be redacted out of a run's record. Only *values* — the
 * deployment file holds variable names, and the value is whatever the process
 * environment supplied.
 */

import type { Deployment } from './types.ts'

export function collectSecrets(deployment: Deployment, env: Readonly<Record<string, string | undefined>>): string[] {
	const secrets = new Set<string>()
	for (const provider of Object.values(deployment.providers)) {
		if (provider.apiKeyEnv === undefined) continue
		const value = env[provider.apiKeyEnv]
		if (value !== undefined && value !== '') secrets.add(value)
	}
	return [...secrets]
}
