import type { ToolResult } from './types.ts'

/**
 * Every tool reports a bad argument the same way, so the model learns one shape
 * to react to and the engine never has to special-case a tool.
 */
export function invalidArguments(message: string): ToolResult {
	return { kind: 'invalid_arguments', message }
}
