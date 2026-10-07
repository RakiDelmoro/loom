/**
 * The git leaf.
 *
 * The only place a git subprocess is spawned. Everything above it is testable
 * against a fake, which is what keeps the fast test suite free of subprocesses
 * while still covering every command the engine issues.
 *
 * Failures are values: a non-zero exit and a missing `git` binary both come back
 * as `failed`, never as a thrown exception.
 */

import { spawnSync } from 'node:child_process'

export type GitResult =
	| { readonly kind: 'ok'; readonly stdout: string }
	| { readonly kind: 'failed'; readonly message: string }

export interface GitRunner {
	run(args: readonly string[]): GitResult
}

export function createGitRunner(options: { readonly cwd: string }): GitRunner {
	return {
		run(args: readonly string[]): GitResult {
			// spawnSync reports a missing binary through `error` rather than
			// throwing, so no exception handling is needed here.
			const spawned = spawnSync('git', [...args], { cwd: options.cwd, encoding: 'utf8' })
			if (spawned.error !== undefined) return { kind: 'failed', message: spawned.error.message }

			const stdout = spawned.stdout ?? ''
			const stderr = spawned.stderr ?? ''
			if (spawned.status !== 0) {
				const detail = stderr.trim() !== '' ? stderr.trim() : stdout.trim()
				return { kind: 'failed', message: `git ${args.join(' ')} exited ${String(spawned.status)}: ${detail}` }
			}
			return { kind: 'ok', stdout }
		},
	}
}
