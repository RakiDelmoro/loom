/**
 * The deployment file: the half of the configuration the Blueprint must never
 * hold.
 *
 * The Blueprint says *which* profile a role uses. The deployment file says what
 * that profile actually is — an endpoint, where its credential lives, and what
 * the model costs. Keeping the two apart is what lets the Tuner rewrite behavior
 * without ever being able to reach a secret.
 */

export interface ProviderConfig {
	/** Base URL without the trailing `/chat/completions`. */
	readonly baseUrl: string
	/**
	 * The **name** of the environment variable holding the key — never the key
	 * itself. A credential that lives only in the process environment cannot be
	 * committed, copied into a Blueprint, or leaked into a manifest.
	 */
	readonly apiKeyEnv?: string
}

export interface ModelPrice {
	readonly inputPer1M: number
	readonly cachedInputPer1M: number
	readonly outputPer1M: number
}

export interface Deployment {
	readonly providers: Readonly<Record<string, ProviderConfig>>
	readonly prices: Readonly<Record<string, ModelPrice>>
}
