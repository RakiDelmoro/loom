/**
 * A scripted provider for tests and for developing without a real model.
 *
 * It is deterministic, offline, and free — which is what lets the rest of the
 * engine (scheduling, worktrees, the bench) be built and tested before a real
 * endpoint exists.
 */

import type { ChatRequest, ChatResult, Provider } from './types.ts'

/** A step is either a fixed result or a function of the request it answers. */
export type FakeStep = ChatResult | ((request: ChatRequest) => ChatResult)

export interface FakeProvider extends Provider {
	/** Every request this provider has been asked for, in order. */
	readonly calls: readonly ChatRequest[]
}

/**
 * Returns the scripted steps in order, one per call. Running past the end of the
 * script is a bug in the test, not a model outcome, so it throws loudly rather
 * than returning a plausible-looking result.
 */
export function createFakeProvider(steps: readonly FakeStep[]): FakeProvider {
	const calls: ChatRequest[] = []
	let next = 0
	return {
		id: 'fake',
		get calls(): readonly ChatRequest[] {
			return calls
		},
		async chat(request: ChatRequest): Promise<ChatResult> {
			calls.push(request)
			const step = steps[next]
			next += 1
			if (step === undefined) {
				throw new Error(`fake provider: script exhausted after ${steps.length} step(s)`)
			}
			return typeof step === 'function' ? step(request) : step
		},
	}
}
