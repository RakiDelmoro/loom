import { describe, expect, test } from 'bun:test'
import { advance, shouldTerminate } from './guardrails.ts'
import type { TunerConfig, TunerState } from './types.ts'

const config: TunerConfig = {
	suitePath: '/suite',
	guildPath: '/guild',
	deploymentPath: '/deployment.json',
	maxCycles: 3,
	maxCostUsd: 1,
	plateauLimit: 2,
	improvementMargin: 0.1,
	repetitions: 1,
	bigModel: { provider: 'stub', model: 'big' },
}

function state(overrides: Partial<TunerState> = {}): TunerState {
	return { cycles: 0, costUsd: 0, plateau: 0, ...overrides }
}

describe('shouldTerminate', () => {
	test('an untouched state keeps going', () => {
		expect(shouldTerminate(state(), config)).toEqual({ stop: false, reason: null })
	})

	test('the cycle budget stops the loop and says so', () => {
		const termination = shouldTerminate(state({ cycles: 3 }), config)
		expect(termination.stop).toBe(true)
		expect(termination.reason).toContain('cycle budget of 3')
	})

	test("the Tuner's own spend stops the loop", () => {
		const termination = shouldTerminate(state({ costUsd: 1 }), config)
		expect(termination.stop).toBe(true)
		expect(termination.reason).toContain("Tuner's own spend")
	})

	test('a plateau stops the loop', () => {
		const termination = shouldTerminate(state({ plateau: 2 }), config)
		expect(termination.stop).toBe(true)
		expect(termination.reason).toContain('consecutive cycles improved nothing')
	})

	test('the cost ceiling is checked before the cycle budget', () => {
		expect(shouldTerminate(state({ cycles: 3, costUsd: 1 }), config).reason).toContain('spend')
	})

	test('a zero cost ceiling stops immediately', () => {
		expect(shouldTerminate(state(), { ...config, maxCostUsd: 0 }).stop).toBe(true)
	})
})

describe('advance', () => {
	test('counts the cycle and adds the spend', () => {
		expect(advance(state(), { improved: 0, costUsd: 0.25 })).toEqual({ cycles: 1, costUsd: 0.25, plateau: 1 })
	})

	test('an improvement resets the plateau', () => {
		expect(advance(state({ plateau: 2 }), { improved: 1, costUsd: 0 }).plateau).toBe(0)
	})

	test('no improvement advances the plateau', () => {
		expect(advance(state({ plateau: 1 }), { improved: 0, costUsd: 0 }).plateau).toBe(2)
	})
})
