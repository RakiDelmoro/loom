/**
 * A scripted provider for tests and for developing without a real model.
 *
 * It is deterministic, offline, and free — which is what lets the rest of the
 * engine (scheduling, worktrees, the bench) be built and tested before a real
 * endpoint exists.
 */

import type { ChatRequest, ChatResult, Provider } from './types.ts'

/** A step is either a fixed result or a function of the request it answers. */
export type FakeStep = ChatResult | ((request: ChatRequest) => ChatResult | Promise<ChatResult>)

/**
 * Either a sequence consumed one call at a time, or a function consulted on
 * every call. Use the function form when the answer depends on which role is
 * asking — or when it must wait for something, as a concurrency test does.
 */
export type FakeScript = readonly FakeStep[] | ((request: ChatRequest) => ChatResult | Promise<ChatResult>)

export interface FakeProvider extends Provider {
	/** Every request this provider has been asked for, in order. */
	readonly calls: readonly ChatRequest[]
}

/**
 * Running past the end of a scripted sequence is a bug in the test, not a model
 * outcome, so it throws loudly rather than returning a plausible-looking result.
 */
export function createFakeProvider(script: FakeScript): FakeProvider {
	const calls: ChatRequest[] = []
	let next = 0
	return {
		id: 'fake',
		get calls(): readonly ChatRequest[] {
			return calls
		},
		async chat(request: ChatRequest): Promise<ChatResult> {
			calls.push(request)
			if (typeof script === 'function') return script(request)
			const step = script[next]
			next += 1
			if (step === undefined) {
				throw new Error(`fake provider: script exhausted after ${script.length} step(s)`)
			}
			return typeof step === 'function' ? step(request) : step
		},
	}
}
