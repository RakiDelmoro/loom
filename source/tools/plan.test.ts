import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createToolRegistry } from './registry.ts'
import { createPlanToolHandlers } from './plan.ts'

// The plan lives outside any workspace, so the context root is deliberately a
// different directory from the plan's.
const CONTEXT = { workspaceRoot: '/repo/worktrees/coder-1' }
const PLAN_PATH = '/repo/.loom/runs/run-1/plan.md'

function tools(files: Readonly<Record<string, string>> = {}) {
	const memory = createMemoryFileSystem(files, ['/repo'])
	return { registry: createToolRegistry(createPlanToolHandlers({ fs: memory.fs, planPath: PLAN_PATH })), memory }
}

describe('the plan tools', () => {
	test('a plan written by one role is read back by the next', async () => {
		const { registry, memory } = tools()

		const written = await registry.run('write_plan', { plan: '1. split money.rs\n2. wire the three callers' }, CONTEXT)
		expect(written.kind).toBe('success')
		expect(memory.files.get(PLAN_PATH)).toBe('1. split money.rs\n2. wire the three callers')

		const read = await registry.run('read_plan', {}, CONTEXT)
		expect(read).toEqual({ kind: 'success', data: { exists: true, plan: '1. split money.rs\n2. wire the three callers' } })
	})

	test('a run without a plan says so rather than failing', async () => {
		const { registry } = tools()
		expect(await registry.run('read_plan', {}, CONTEXT)).toEqual({ kind: 'success', data: { exists: false, plan: '' } })
	})

	test('writing again replaces the plan instead of appending to it', async () => {
		const { registry } = tools()

		await registry.run('write_plan', { plan: 'first partition' }, CONTEXT)
		await registry.run('write_plan', { plan: 'second partition' }, CONTEXT)

		const read = await registry.run('read_plan', {}, CONTEXT)
		expect(read).toEqual({ kind: 'success', data: { exists: true, plan: 'second partition' } })
	})

	test('an empty plan is refused', async () => {
		const { registry, memory } = tools()

		expect((await registry.run('write_plan', { plan: '' }, CONTEXT)).kind).toBe('invalid_arguments')
		expect((await registry.run('write_plan', { plan: '   \n' }, CONTEXT)).kind).toBe('invalid_arguments')
		expect(memory.files.has(PLAN_PATH)).toBe(false)
	})
})