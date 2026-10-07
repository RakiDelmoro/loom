/**
 * The tool boundary.
 *
 * A tool call is where the engine meets unpredictable code — a model's
 * arguments, a shell, a filesystem. Every outcome is a `ToolResult`, so a tool
 * failure is something the calling agent can read and react to, never something
 * that takes the run down.
 */

export type ToolErrorKind =
	| 'invalid_arguments'
	| 'unknown_tool'
	| 'permission_denied'
	| 'outside_workspace'
	| 'timeout'
	| 'unavailable'
	| 'failed'

export type ToolResult =
	| { readonly kind: 'success'; readonly data: unknown }
	| { readonly kind: ToolErrorKind; readonly message: string; readonly details?: unknown }

export interface ToolContext {
	/** The directory the tool is confined to — an agent's own worktree. */
	readonly workspaceRoot: string
}

export interface ToolHandler {
	readonly name: string
	run(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolResult>
}

export interface ToolRegistry {
	has(name: string): boolean
	names(): readonly string[]
	run(name: string, args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolResult>
}
