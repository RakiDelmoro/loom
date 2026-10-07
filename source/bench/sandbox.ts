/**
 * The benchmark sandbox leaf.
 *
 * A benchmark workspace is not a repository, and the engine needs one (it
 * branches agents from a commit). So each run gets a throwaway copy of the
 * benchmark's `workspace/`, initialized as a git repository with one commit —
 * which is also what keeps one benchmark's installs or downloads out of
 * another's.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { OpResult } from '../result.ts'
import { failed, ok } from '../result.ts'
import type { GitRunner } from '../workspace/git.ts'

export interface BenchmarkSandbox {
	/** A fresh, isolated copy of `sourceWorkspace`, as a repository with one commit. */
	create(sourceWorkspace: string): OpResult<string>
	remove(directory: string): void
}

export interface BenchmarkSandboxDependencies {
	readonly gitFor: (cwd: string) => GitRunner
}

export function createBenchmarkSandbox(dependencies: BenchmarkSandboxDependencies): BenchmarkSandbox {
	return {
		create(sourceWorkspace: string): OpResult<string> {
			let directory: string
			try {
				directory = mkdtempSync(path.join(tmpdir(), 'loom-bench-'))
				cpSync(sourceWorkspace, directory, { recursive: true })
			} catch (error) {
				// Temp-directory and copy failures are the operating system's, not
				// the benchmark's; they are reported rather than thrown so one bad
				// benchmark cannot abort a whole suite run.
				return failed(error instanceof Error ? error.message : String(error))
			}

			const git = dependencies.gitFor(directory)
			const commands: Array<readonly string[]> = [
				['init', '-q', '-b', 'main'],
				['add', '-A'],
				['-c', 'user.name=Bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '--allow-empty', '-m', 'benchmark workspace'],
			]
			for (const args of commands) {
				const result = git.run(args)
				if (result.kind !== 'ok') return failed(result.message)
			}
			return ok(directory)
		},

		remove(directory: string): void {
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

/** True when `git` is on PATH, so a suite run can say so plainly instead of failing per benchmark. */
export function gitIsAvailable(): boolean {
	const spawned = spawnSync('git', ['--version'], { encoding: 'utf8' })
	return spawned.status === 0
}
