import { describe, expect, test } from 'bun:test'
import { createToolPolicy } from './policy.ts'

function policy(options: { mode?: 'read-only' | 'workspace-write' | 'full'; requireApproval?: readonly string[]; approvals?: readonly string[] } = {}) {
	return createToolPolicy({
		mode: options.mode ?? 'workspace-write',
		requireApproval: options.requireApproval ?? [],
		approvals: options.approvals ?? [],
	})
}

describe('createToolPolicy', () => {
	test('a read-only run refuses every tool that changes the workspace', () => {
		const readOnly = policy({ mode: 'read-only' })
		for (const tool of ['write_file', 'run_shell', 'typecheck', 'test']) {
			expect(readOnly.decide(tool).kind).toBe('deny')
		}
	})

	test('a read-only run allows tools that only read', () => {
		const readOnly = policy({ mode: 'read-only' })
		for (const tool of ['read_file', 'list_dir', 'glob', 'search', 'git_status', 'finish']) {
			expect(readOnly.decide(tool).kind).toBe('allow')
		}
	})

	test('the refusal says why', () => {
		const decision = policy({ mode: 'read-only' }).decide('write_file')
		if (decision.kind !== 'deny') throw new Error('expected a denial')
		expect(decision.reason).toContain('read-only')
		expect(decision.reason).toContain('write_file')
	})

	test('workspace-write allows tools that change the workspace', () => {
		expect(policy({ mode: 'workspace-write' }).decide('write_file').kind).toBe('allow')
	})

	test('a tool needing approval is refused when the run was not granted it', () => {
		const decision = policy({ requireApproval: ['run_shell'] }).decide('run_shell')
		expect(decision.kind).toBe('deny')
		if (decision.kind !== 'deny') throw new Error('expected a denial')
		expect(decision.reason).toContain('requires approval')
	})

	test('a tool needing approval is allowed once the run has been granted it', () => {
		expect(policy({ requireApproval: ['run_shell'], approvals: ['run_shell'] }).decide('run_shell').kind).toBe('allow')
	})

	test('an approval for one tool does not approve another', () => {
		expect(policy({ requireApproval: ['run_shell', 'test'], approvals: ['run_shell'] }).decide('test').kind).toBe('deny')
	})

	test('the mode outranks an approval — approving a write does not make a read-only run writable', () => {
		const decision = policy({ mode: 'read-only', requireApproval: ['write_file'], approvals: ['write_file'] }).decide('write_file')
		expect(decision.kind).toBe('deny')
	})

	test('an unknown tool is allowed — the grant list is what refuses it', () => {
		// The policy knows about containment, not about which tools exist.
		expect(policy().decide('anything').kind).toBe('allow')
	})
})
