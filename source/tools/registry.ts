/**
 * Tool dispatch by name.
 *
 * A tool handler is external code: it reads the filesystem, spawns a shell, or
 * talks to git. Anything it does — including throwing — becomes a `ToolResult`,
 * because the run must survive a misbehaving tool and let the agent adapt.
 */

import { describeError } from '../errors.ts'
import type { ToolContext, ToolHandler, ToolRegistry, ToolResult } from './types.ts'

export function createToolRegistry(handlers: readonly ToolHandler[]): ToolRegistry {
	const byName = new Map<string, ToolHandler>()
	for (const handler of handlers) byName.set(handler.name, handler)

	return {
		has(name: string): boolean {
			return byName.has(name)
		},
		names(): readonly string[] {
			return [...byName.keys()].sort()
		},
		async run(name: string, args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolResult> {
			const handler = byName.get(name)
			if (handler === undefined) return { kind: 'unknown_tool', message: `no tool named "${name}"` }
			try {
				return await handler.run(args, context)
			} catch (error) {
				return { kind: 'failed', message: describeError(error) }
			}
		},
	}
}
