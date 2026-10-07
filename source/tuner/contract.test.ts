import { describe, expect, test } from 'bun:test'
import { contractViolations, type ContractView } from './contract.ts'

function view(overrides: Partial<ContractView> = {}): ContractView {
	return {
		roles: {
			orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
			reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
		},
		permissions: { mode: 'workspace-write' },
		routing: {
			reasoner: { provider: 'together', model: 'big-model' },
			worker: { provider: 'together', model: 'big-model' },
		},
		...overrides,
	}
}

describe('contractViolations', () => {
	test('an unchanged Blueprint breaks nothing', () => {
		expect(contractViolations(view(), view())).toEqual([])
	})

	test('weakening the permission mode is refused', () => {
		const candidate = view({ permissions: { mode: 'full' } })
		expect(contractViolations(view(), candidate)).toEqual(['permissions.mode was weakened from "workspace-write" to "full"'])
	})

	test('strengthening the permission mode is allowed', () => {
		const baseline = view({ permissions: { mode: 'full' } })
		expect(contractViolations(baseline, view({ permissions: { mode: 'read-only' } }))).toEqual([])
	})

	test('granting a role a mutating tool is admissible as long as the role stays isolated', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
				// The reviewer gains the ability to edit — a quality question the Bench
				// decides. It stays isolated, so it is admissible.
				reviewer: { tools: ['read_file', 'write_file', 'finish'], isolation: 'worktree' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([])
	})

	test('granting a mutating tool to a role that is not isolated is refused', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
				reviewer: { tools: ['read_file', 'write_file', 'finish'], isolation: 'shared' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([
			'role "reviewer" can change the workspace but is not worktree-isolated',
		])
	})

	test('taking a mutating tool away is allowed', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'finish'], isolation: 'worktree' },
				reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([])
	})

	test('a role that can write but is not worktree-isolated is refused', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'shared' },
				reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([
			'role "orchestrator" can change the workspace but is not worktree-isolated',
		])
	})

	test('a read-only role may be moved to shared isolation', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
				reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([])
	})

	test('a role the candidate added is judged on its own merits', () => {
		const candidate = view({
			roles: {
				orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
				reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
				helper: { tools: ['run_shell', 'finish'], isolation: 'shared' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([
			'role "helper" can change the workspace but is not worktree-isolated',
		])
	})
})

describe('the pinned model', () => {
	test('editing a profile to a model the baseline does not run is refused', () => {
		const candidate = view({ routing: { worker: { provider: 'together', model: 'cheap-model' } } })
		const violations = contractViolations(view(), candidate)

		expect(violations).toHaveLength(1)
		expect(violations[0]).toContain('together/cheap-model')
		expect(violations[0]).toContain('pinned to together/big-model')
	})

	test('adding a profile that points elsewhere is the same move, and is refused', () => {
		// The longer route around the rule: leave the existing profile alone and
		// give a role a new one. Checking the candidate's profiles rather than the
		// edits covers both.
		const candidate = view({
			routing: {
				reasoner: { provider: 'together', model: 'big-model' },
				worker: { provider: 'together', model: 'big-model' },
				'worker-cheap': { provider: 'together', model: 'cheap-model' },
			},
		})
		expect(contractViolations(view(), candidate)).toHaveLength(1)
	})

	test('changing the provider under the same model name is refused', () => {
		const candidate = view({ routing: { reasoner: { provider: 'local', model: 'big-model' } } })
		expect(contractViolations(view(), candidate)).toHaveLength(1)
	})

	test('a profile the baseline already runs may be reshaped as long as the model is kept', () => {
		// A role moving onto the other profile is a setup decision — both name the
		// same model, so nothing about the model changed.
		const candidate = view({
			routing: {
				reasoner: { provider: 'together', model: 'big-model' },
				summarizer: { provider: 'together', model: 'big-model' },
			},
		})
		expect(contractViolations(view(), candidate)).toEqual([])
	})

	test('an unchanged model is admissible', () => {
		expect(contractViolations(view(), view())).toEqual([])
	})
})
