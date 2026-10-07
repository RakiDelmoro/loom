import { describe, expect, test } from 'bun:test'
import { delay } from '../test-support/clock.ts'
import type { ChatRequest, Provider } from '../model/types.ts'
import { createLimitedProvider, createPool } from './pool.ts'

const request: ChatRequest = {
	model: 'test',
	messages: [],
	tools: [],
	temperature: 0,
	maxTokens: 16,
}

describe('createPool', () => {
	test('never runs more than the ceiling at once', async () => {
		const pool = createPool({ maxConcurrent: 2 })
		let active = 0
		let peak = 0

		const results = await Promise.all(
			[0, 1, 2, 3, 4, 5].map((index) =>
				pool.run(async () => {
					active += 1
					peak = Math.max(peak, active)
					await delay(1)
					active -= 1
					return index
				}),
			),
		)

		expect(peak).toBe(2)
		expect(results).toEqual([0, 1, 2, 3, 4, 5])
	})

	test('releases its slot when the task throws', async () => {
		const pool = createPool({ maxConcurrent: 1 })

		await expect(
			pool.run(async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')

		// If the slot had leaked, this second task would never start.
		expect(await pool.run(async () => 'ok')).toBe('ok')
	})

	test('runs a single task straight through', async () => {
		const pool = createPool({ maxConcurrent: 1 })
		expect(await pool.run(async () => 42)).toBe(42)
	})
})

describe('createLimitedProvider', () => {
	test('routes every model call through the pool', async () => {
		const pool = createPool({ maxConcurrent: 1 })
		let active = 0
		let peak = 0

		const provider: Provider = {
			id: 'slow',
			async chat() {
				active += 1
				peak = Math.max(peak, active)
				await delay(1)
				active -= 1
				return { kind: 'success', response: { content: 'ok', toolCalls: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, finishReason: 'stop' } }
			},
		}

		const limited = createLimitedProvider(provider, pool)
		await Promise.all([limited.chat(request), limited.chat(request), limited.chat(request)])

		expect(peak).toBe(1)
	})

	test('keeps the provider id', () => {
		const limited = createLimitedProvider({ id: 'local', chat: async () => ({ kind: 'unavailable', message: 'x' }) }, createPool({ maxConcurrent: 1 }))
		expect(limited.id).toBe('local')
	})
})
