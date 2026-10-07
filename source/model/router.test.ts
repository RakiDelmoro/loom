import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import type { LoadedBlueprint } from '../blueprint/types.ts'
import { routeAllRoles, routeRole } from './router.ts'

const blueprint: LoadedBlueprint = {
	entryRole: 'orchestrator',
	roles: {
		orchestrator: { prompt: 'p', model: 'reasoner', tools: [], isolation: 'worktree', maxChildren: 1, systemPrompt: 'x' },
		coder: { prompt: 'p', model: 'worker', tools: [], isolation: 'worktree', maxChildren: 1, systemPrompt: 'x' },
		reviewer: { prompt: 'p', model: 'reasoner', tools: [], isolation: 'shared', maxChildren: 1, systemPrompt: 'x' },
	},
	tools: [],
	routing: {
		reasoner: { provider: 'anthropic', model: 'claude-sonnet-4', temperature: 0.2 },
		worker: { provider: 'local', model: 'qwen3-coder-30b', temperature: 0.1 },
	},
	budgets: { maxAgentDepth: 6, maxConcurrentAgents: 8, maxCostUsd: 5, maxTokensPerRun: 2000000, toolTimeoutSeconds: 60 },
	permissions: { mode: 'workspace-write', requireApproval: [] },
}

describe('routeRole', () => {
	test('resolves a role to the profile it declares', () => {
		expect(routeRole(blueprint, 'coder')).toEqual({ provider: 'local', model: 'qwen3-coder-30b', temperature: 0.1 })
	})

	test('reports an unknown role by path', () => {
		try {
			routeRole(blueprint, 'ghost')
		} catch (error) {
			if (!(error instanceof ValidationError)) throw error
			expect(error.path).toBe('roles.ghost')
			return
		}
		throw new Error('expected a ValidationError')
	})
})

describe('routeAllRoles', () => {
	test('maps every role in the Blueprint to a profile', () => {
		const table = routeAllRoles(blueprint)
		expect(Object.keys(table).sort()).toEqual(['coder', 'orchestrator', 'reviewer'])
		expect(table['orchestrator']?.model).toBe('claude-sonnet-4')
		expect(table['reviewer']?.model).toBe('claude-sonnet-4')
		expect(table['coder']?.provider).toBe('local')
	})

	test('routes two roles that share a profile to the same profile object', () => {
		const table = routeAllRoles(blueprint)
		expect(table['orchestrator']).toBe(table['reviewer'])
	})
})
