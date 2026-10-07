/**
 * The subprocess leaf.
 *
 * The only place a shell is spawned. It is a leaf like the git runner: the
 * failure modes a shell has — a non-zero exit, a timeout, a command that does
 * not exist — all come back as values.
 */

import { spawnSync } from 'node:child_process'

export type RunCommandResult =
	| { readonly kind: 'ok'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
	| { readonly kind: 'timeout'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string }

export type RunCommand = (
	command: string,
	options: { readonly cwd: string; readonly timeoutMs: number },
) => RunCommandResult

export function createRunCommand(): RunCommand {
	return (command, options) => {
		const spawned = spawnSync('sh', ['-c', command], {
			cwd: options.cwd,
			encoding: 'utf8',
			timeout: options.timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		})

		if (spawned.error !== undefined) {
			// A killed command reports through `error`, so a timeout is
			// distinguished here rather than by inspecting the exit code.
			if ('code' in spawned.error && spawned.error.code === 'ETIMEDOUT') {
				return { kind: 'timeout', message: `command exceeded ${String(options.timeoutMs)}ms` }
			}
			return { kind: 'failed', message: spawned.error.message }
		}

		return {
			kind: 'ok',
			exitCode: spawned.status ?? -1,
			stdout: spawned.stdout ?? '',
			stderr: spawned.stderr ?? '',
		}
	}
}
