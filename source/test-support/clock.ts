/**
 * Test clocks and synchronization.
 *
 * Timestamps in the engine come from an injected `now`, so a test can make them
 * deterministic instead of racing the wall clock.
 */

/** Each call returns the next integer. Ordering is exact and reproducible. */
export function createCounterClock(start = 0): () => number {
	let value = start
	return () => {
		value += 1
		return value
	}
}

/** Waits for the event loop to turn, so concurrently started work can interleave. */
export function delay(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>()
	setTimeout(resolve, milliseconds)
	return promise
}

/**
 * A gate that opens once `parties` callers have arrived.
 *
 * This is how a test proves concurrency without timing anything: work that is
 * serialized never reaches the count, so the gate never opens.
 */
export function createBarrier(parties: number): { arrive(): Promise<void> } {
	let arrived = 0
	const { promise, resolve } = Promise.withResolvers<void>()
	return {
		async arrive(): Promise<void> {
			arrived += 1
			if (arrived >= parties) resolve()
			await promise
		},
	}
}
