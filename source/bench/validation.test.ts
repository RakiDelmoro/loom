import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import type { RunCommand } from '../tools/run-command.ts'
import type { ValidationSpec } from './types.ts'
import { evaluateValidation, runValidation, type ValidationObservation } from './validation.ts'

const spec: ValidationSpec = {
	command: 'bun test',
	expectedExitCode: 0,
	expectedFiles: ['src/a.ts'],
	expectedStdoutContains: ['2 pass'],
	timeoutSeconds: 30,
}

function observation(overrides: Partial<ValidationObservation> = {}): ValidationObservation {
	return { exitCode: 0, stdout: '2 pass\n', timedOut: false, missingFiles: [], unavailable: null, ...overrides }
}

describe('evaluateValidation', () => {
	test('passes when every expectation holds', () => {
		expect(evaluateValidation(spec, observation())).toEqual({ status: 'pass', reasons: [] })
	})

	test('reports a missing file', () => {
		const result = evaluateValidation(spec, observation({ missingFiles: ['src/a.ts'] }))
		expect(result.status).toBe('fail')
		expect(result.reasons).toEqual(['expected file is missing: src/a.ts'])
	})

	test('reports a wrong exit code', () => {
		expect(evaluateValidation(spec, observation({ exitCode: 1 })).reasons).toEqual(['expected exit code 0, got 1'])
	})

	test('reports missing stdout text', () => {
		expect(evaluateValidation(spec, observation({ stdout: '1 fail' })).reasons).toEqual(['stdout does not contain: 2 pass'])
	})

	test('collects every failed expectation rather than stopping at the first', () => {
		const result = evaluateValidation(spec, observation({ exitCode: 2, stdout: '', missingFiles: ['src/a.ts'] }))
		expect(result.reasons).toHaveLength(3)
	})

	test('a timeout short-circuits to a single reason', () => {
		const result = evaluateValidation(spec, observation({ timedOut: true, exitCode: null }))
		expect(result.reasons).toEqual(['the validation command exceeded 30s'])
	})

	test('a command that could not start is reported as such', () => {
		const result = evaluateValidation(spec, observation({ unavailable: 'spawn failed' }))
		expect(result.reasons).toEqual(['the validation command could not start: spawn failed'])
	})
})

describe('runValidation', () => {
	function createDependencies(runCommand: RunCommand, files: Record<string, string> = {}) {
		const memory = createMemoryFileSystem(files, ['/workspace'])
		return { fs: memory.fs, runCommand }
	}

	test('observes the command output and the files that exist', () => {
		const dependencies = createDependencies(
			() => ({ kind: 'ok', exitCode: 0, stdout: '2 pass\n', stderr: '' }),
			{ '/workspace/src/a.ts': 'x' },
		)

		expect(runValidation(dependencies, '/workspace', spec)).toEqual({
			exitCode: 0,
			stdout: '2 pass\n',
			timedOut: false,
			missingFiles: [],
			unavailable: null,
		})
	})

	test('reports a missing expected file', () => {
		const dependencies = createDependencies(() => ({ kind: 'ok', exitCode: 0, stdout: '2 pass\n', stderr: '' }))
		expect(runValidation(dependencies, '/workspace', spec).missingFiles).toEqual(['src/a.ts'])
	})

	test('maps a timeout without running anything else', () => {
		const dependencies = createDependencies(() => ({ kind: 'timeout', message: 'too slow' }))
		const observed = runValidation(dependencies, '/workspace', spec)
		expect(observed.timedOut).toBe(true)
		expect(observed.exitCode).toBeNull()
	})

	test('maps a command that could not start', () => {
		const dependencies = createDependencies(() => ({ kind: 'failed', message: 'no shell' }))
		expect(runValidation(dependencies, '/workspace', spec).unavailable).toBe('no shell')
	})
})
