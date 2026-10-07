/**
 * Path confinement.
 *
 * Every path a tool accepts is resolved against the workspace root and refused
 * if it escapes. The workspace root is an agent's own worktree, so this is the
 * layer that stops one agent from reaching another agent's files.
 *
 * Lexical only: symlinks are not followed, so a symlink placed inside the
 * workspace could still point outside it. Containing that is the deployment
 * sandbox's job, not this function's.
 */

import * as path from 'node:path'

export type WorkspacePathResult =
	| { readonly kind: 'ok'; readonly path: string }
	| { readonly kind: 'outside'; readonly message: string }

export function resolveWorkspacePath(workspaceRoot: string, requested: string): WorkspacePathResult {
	const root = path.resolve(workspaceRoot)
	const resolved = path.resolve(root, requested)
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		return { kind: 'outside', message: `path escapes the workspace: ${requested}` }
	}
	return { kind: 'ok', path: resolved }
}

/** The workspace-relative, slash-separated form of an absolute path. */
export function toRelativePath(workspaceRoot: string, absolutePath: string): string {
	return path.relative(path.resolve(workspaceRoot), absolutePath).split(path.sep).join('/')
}
