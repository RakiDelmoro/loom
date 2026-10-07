/**
 * The git introspection tools: read-only views of the agent's own worktree.
 *
 * They pass `-C <workspaceRoot>`, so the runner's own working directory is
 * irrelevant and every agent inspects its own tree.
 */

import type { GitRunner } from '../workspace/git.ts'
import { invalidArguments } from './arguments.ts'
import type { ToolHandler, ToolResult } from './types.ts'

export interface GitToolDependencies {
	readonly git: GitRunner
}

export function createGitToolHandlers(dependencies: GitToolDependencies): readonly ToolHandler[] {
	return [createGitStatusTool(dependencies), createGitDiffTool(dependencies), createGitLogTool(dependencies)]
}

function createGitStatusTool(dependencies: GitToolDependencies): ToolHandler {
	return {
		name: 'git_status',
		async run(_args, context): Promise<ToolResult> {
			const result = dependencies.git.run(['-C', context.workspaceRoot, 'status', '--porcelain'])
			if (result.kind !== 'ok') return { kind: 'unavailable', message: result.message }
			return { kind: 'success', data: { status: result.stdout.trim() } }
		},
	}
}

function createGitDiffTool(dependencies: GitToolDependencies): ToolHandler {
	return {
		name: 'git_diff',
		async run(args, context): Promise<ToolResult> {
			const base = args['base'] === undefined ? 'HEAD' : args['base']
			if (typeof base !== 'string' || base === '') return invalidArguments('base must be a non-empty string')

			const requestedPath = args['path']
			if (requestedPath !== undefined && typeof requestedPath !== 'string') {
				return invalidArguments('path must be a string')
			}

			const command = ['-C', context.workspaceRoot, 'diff', base]
			if (typeof requestedPath === 'string') command.push('--', requestedPath)

			const result = dependencies.git.run(command)
			if (result.kind !== 'ok') return { kind: 'unavailable', message: result.message }
			return { kind: 'success', data: { base, diff: result.stdout } }
		},
	}
}

function createGitLogTool(dependencies: GitToolDependencies): ToolHandler {
	return {
		name: 'git_log',
		async run(args, context): Promise<ToolResult> {
			const requested = args['limit'] === undefined ? 20 : args['limit']
			if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
				return invalidArguments('limit must be a positive integer')
			}

			const result = dependencies.git.run(['-C', context.workspaceRoot, 'log', `-${String(requested)}`, '--format=%H %s'])
			if (result.kind !== 'ok') return { kind: 'unavailable', message: result.message }
			return { kind: 'success', data: { entries: result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n') } }
		},
	}
}
