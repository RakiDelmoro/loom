/**
 * A provider registry for tests: every name resolves to the one supplied
 * provider, so a scheduler test never needs a deployment file or a network.
 */

import type { ProviderRegistry } from '../deployment/registry.ts'
import type { Provider } from '../model/types.ts'
import { ok } from '../result.ts'

export function createFakeRegistry(provider: Provider): ProviderRegistry {
	return {
		has: () => true,
		names: () => ['test'],
		create: () => ok(provider),
	}
}

/** A registry that refuses every request, for testing the failure path. */
export function createFailingRegistry(message: string): ProviderRegistry {
	return {
		has: () => true,
		names: () => ['test'],
		create: () => ({ kind: 'failed', message }),
	}
}
