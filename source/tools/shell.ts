/**
 * `run_shell` — the general escape hatch.
 *
 * Containment is the deployment sandbox's job, not this tool's: there is no
 * command allowlist here, by design. What this tool does enforce is the
 * workspace working directory and a hard timeout ceiling.
 */

import { invalidArguments } from './arguments.ts'
import type { RunCommand } from './run-command.ts'
import type { ToolHandler, ToolResult } from './types.ts'

export interface ShellToolDependencies {
	readonly runCommand: RunCommand
	readonly defaultTimeoutSeconds: number
}

export function createShellToolHandlers(dependencies: ShellToolDependencies): readonly ToolHandler[] {
	return [createRunShellTool(dependencies)]
}

function createRunShellTool(dependencies: ShellToolDependencies): ToolHandler {
	const ceilingMs = dependencies.defaultTimeoutSeconds * 1000

	return {
		name: 'run_shell',
		async run(args, context): Promise<ToolResult> {
			const command = args['command']
			if (typeof command !== 'string' || command === '') return invalidArguments('command must be a non-empty string')

			const requested = args['timeoutSeconds']
			if (requested !== undefined && typeof requested !== 'number') {
				return invalidArguments('timeoutSeconds must be a number')
			}

			// A call may ask for less time than the run allows, never more.
			const timeoutMs = Math.min(typeof requested === 'number' ? requested * 1000 : ceilingMs, ceilingMs)

			const result = dependencies.runCommand(command, { cwd: context.workspaceRoot, timeoutMs })
			if (result.kind === 'timeout') return { kind: 'timeout', message: result.message }
			if (result.kind === 'failed') return { kind: 'unavailable', message: result.message }

			return {
				kind: 'success',
				data: { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
			}
		},
	}
}
