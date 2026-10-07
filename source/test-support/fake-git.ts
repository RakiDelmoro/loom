/**
 * A scripted git runner.
 *
 * Records every command and answers from the supplied function; a command the
 * test did not script is a bug in the test, so it throws rather than returning
 * something plausible.
 */

import type { GitResult, GitRunner } from '../workspace/git.ts'

export interface FakeGit {
	readonly runner: GitRunner
	readonly commands: readonly string[][]
}

export function createFakeGit(respond: (args: readonly string[]) => GitResult | undefined): FakeGit {
	const commands: string[][] = []
	return {
		commands,
		runner: {
			run(args: readonly string[]): GitResult {
				commands.push([...args])
				const result = respond(args)
				if (result === undefined) throw new Error(`unexpected git call: ${args.join(' ')}`)
				return result
			},
		},
	}
}

export function ok(stdout = ''): GitResult {
	return { kind: 'ok', stdout }
}

export function failed(message: string): GitResult {
	return { kind: 'failed', message }
}
