/**
 * Grading a benchmark's finished workspace.
 *
 * Deterministic first: files exist, the command exits as expected, stdout
 * contains what it should. That is binary, cheap, and reproducible, and most
 * benchmarks should be gradable by it alone.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import type { RunCommand } from '../tools/run-command.ts'
import type { ValidationSpec } from './types.ts'

export interface ValidationObservation {
	readonly exitCode: number | null
	readonly stdout: string
	readonly timedOut: boolean
	readonly missingFiles: readonly string[]
	/** Set when the command could not be started at all. */
	readonly unavailable: string | null
}

export interface ValidationOutcome {
	readonly status: 'pass' | 'fail'
	readonly reasons: readonly string[]
}

/** A timeout short-circuits: there is nothing else worth reporting about a hung command. */
export function evaluateValidation(spec: ValidationSpec, observation: ValidationObservation): ValidationOutcome {
	if (observation.timedOut) {
		return { status: 'fail', reasons: [`the validation command exceeded ${String(spec.timeoutSeconds)}s`] }
	}
	if (observation.unavailable !== null) {
		return { status: 'fail', reasons: [`the validation command could not start: ${observation.unavailable}`] }
	}

	const reasons: string[] = []
	for (const file of observation.missingFiles) reasons.push(`expected file is missing: ${file}`)
	if (observation.exitCode !== spec.expectedExitCode) {
		reasons.push(`expected exit code ${String(spec.expectedExitCode)}, got ${String(observation.exitCode)}`)
	}
	for (const expected of spec.expectedStdoutContains) {
		if (!observation.stdout.includes(expected)) reasons.push(`stdout does not contain: ${expected}`)
	}

	return reasons.length === 0 ? { status: 'pass', reasons: [] } : { status: 'fail', reasons }
}

export interface BenchmarkValidationDependencies {
	readonly fs: FileSystem
	readonly runCommand: RunCommand
}

/** Runs the validation command in the finished workspace and observes what happened. */
export function runValidation(
	dependencies: BenchmarkValidationDependencies,
	workspaceRoot: string,
	spec: ValidationSpec,
): ValidationObservation {
	const missingFiles = spec.expectedFiles.filter((file) => !dependencies.fs.exists(path.join(workspaceRoot, file)))

	const command = dependencies.runCommand(spec.command, {
		cwd: workspaceRoot,
		timeoutMs: spec.timeoutSeconds * 1000,
	})

	if (command.kind === 'timeout') {
		return { exitCode: null, stdout: '', timedOut: true, missingFiles, unavailable: null }
	}
	if (command.kind === 'failed') {
		return { exitCode: null, stdout: '', timedOut: false, missingFiles, unavailable: command.message }
	}
	return { exitCode: command.exitCode, stdout: command.stdout, timedOut: false, missingFiles, unavailable: null }
}
