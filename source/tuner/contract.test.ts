import { describe, expect, test } from 'bun:test'
import { contractViolations, type ContractView } from './contract.ts'

function view(overrides: Partial<ContractView> = {}): ContractView {
	return {
		roles: {
			orchestrator: { tools: ['agent', 'write_file', 'finish'], isolation: 'worktree' },
			reviewer: { tools: ['read_file', 'finish'], isolation: 'shared' },
		},
		permissions: { mode: 'workspace-write' },
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
