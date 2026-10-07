/**
 * Real-git helpers for the integration lane.
 *
 * Imported only by `*.integration.test.ts` files, which are skipped unless
 * LOOM_GIT_TESTS is set — the fast suite never touches a subprocess.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

/** Runs git in `cwd` and returns stdout, throwing on a non-zero exit. */
export function gitOutput(cwd: string, args: readonly string[]): string {
	const spawned = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
	if (spawned.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${spawned.stderr ?? ''}`)
	return spawned.stdout ?? ''
}

/** A throwaway repository on `main`, with one commit so HEAD resolves. */
export function createTemporaryRepository(): string {
	const repo = mkdtempSync(path.join(tmpdir(), 'loom-git-'))
	gitOutput(repo, ['init', '-q', '-b', 'main'])
	writeFileSync(path.join(repo, 'README.md'), 'base\n')
	gitOutput(repo, ['add', '-A'])
	gitOutput(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'initial'])
	return repo
}
