/**
 * The bounded pool, and the model call it bounds.
 *
 * Concurrency is bounded around the **model call**, not around the agent. An
 * agent suspended waiting for its children must not hold a slot, or a tree of
 * agents would deadlock against its own limit; a model call never waits on
 * another slot, so this bound can never deadlock. It is also the honest bound:
 * an in-flight model call is the shared resource every agent competes for.
 */

import type { Provider } from '../model/types.ts'

export interface Pool {
	run<T>(task: () => Promise<T>): Promise<T>
}

export function createPool(options: { readonly maxConcurrent: number }): Pool {
	let active = 0
	const waiting: Array<() => void> = []

	async function acquire(): Promise<void> {
		if (active < options.maxConcurrent) {
			active += 1
			return
		}
		const { promise, resolve } = Promise.withResolvers<void>()
		waiting.push(resolve)
		await promise
		active += 1
	}

	function release(): void {
		active -= 1
		const next = waiting.shift()
		if (next !== undefined) next()
	}

	return {
		async run<T>(task: () => Promise<T>): Promise<T> {
			await acquire()
			try {
				return await task()
			} finally {
				// Released however the task ends. A leaked slot would deadlock the
				// run, so this cleanup is not optional.
				release()
			}
		},
	}
}

/** Wraps a provider so every call passes through the pool. */
export function createLimitedProvider(provider: Provider, pool: Pool): Provider {
	return {
		id: provider.id,
		chat: (request) => pool.run(() => provider.chat(request)),
	}
}
