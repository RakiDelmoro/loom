import { describe, expect, test } from 'bun:test'
import { createToolRegistry } from './registry.ts'
import type { ToolHandler, ToolResult } from './types.ts'

const context = { workspaceRoot: '/repo' }

function handler(name: string, result: ToolResult): ToolHandler {
	return { name, run: async () => result }
}

describe('createToolRegistry', () => {
	test('dispatches a call to the handler registered under that name', async () => {
		const registry = createToolRegistry([
			handler('a', { kind: 'success', data: 'from a' }),
			handler('b', { kind: 'success', data: 'from b' }),
		])
		expect(await registry.run('b', {}, context)).toEqual({ kind: 'success', data: 'from b' })
	})

	test('reports an unknown tool rather than throwing', async () => {
		const registry = createToolRegistry([])
		expect(await registry.run('ghost', {}, context)).toEqual({
			kind: 'unknown_tool',
			message: 'no tool named "ghost"',
		})
	})

	test('turns a handler that throws into a structured result', async () => {
		const exploding: ToolHandler = {
			name: 'boom',
			run: async () => {
				throw new Error('handler exploded')
			},
		}
		const registry = createToolRegistry([exploding])
		expect(await registry.run('boom', {}, context)).toEqual({ kind: 'failed', message: 'handler exploded' })
	})

	test('turns a rejected promise into a structured result', async () => {
		const rejecting: ToolHandler = {
			name: 'reject',
			run: () => Promise.reject(new Error('async failure')),
		}
		const registry = createToolRegistry([rejecting])
		expect(await registry.run('reject', {}, context)).toEqual({ kind: 'failed', message: 'async failure' })
	})

	test('reports its names sorted and answers `has`', () => {
		const registry = createToolRegistry([handler('b', { kind: 'success', data: null }), handler('a', { kind: 'success', data: null })])
		expect(registry.names()).toEqual(['a', 'b'])
		expect(registry.has('a')).toBe(true)
		expect(registry.has('z')).toBe(false)
	})
})
