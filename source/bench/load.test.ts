import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { loadSuite, selectSplit } from './load.ts'

const spec = (id: string): string =>
	JSON.stringify({
		id,
		taskType: 'bugfix',
		difficulty: 'easy',
		task: `do ${id}`,
		validation: { command: 'bun test' },
	})

function buildSuite(config: unknown, ids: readonly string[]) {
	const files: Record<string, string> = { '/suite/suite.json': JSON.stringify(config) }
	const directories = ['/suite']
	for (const id of ids) {
		files[`/suite/${id}/spec.json`] = spec(id)
		files[`/suite/${id}/workspace/README.md`] = 'workspace\n'
		directories.push(`/suite/${id}`, `/suite/${id}/workspace`)
	}
	return createMemoryFileSystem(files, directories)
}

function captureValidationError(subject: () => unknown): ValidationError {
	try {
		subject()
	} catch (error) {
		if (error instanceof ValidationError) return error
		throw error
	}
	throw new Error('expected a ValidationError, but nothing was thrown')
}

describe('loadSuite', () => {
	test('loads every benchmark spec and the split', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: ['b'] }, ['a', 'b'])
		const suite = loadSuite({ fs: memory.fs }, '/suite')

		expect(Object.keys(suite.benchmarks).sort()).toEqual(['a', 'b'])
		expect(suite.benchmarks['a']?.validation.command).toBe('bun test')
		expect(suite.config.heldOut).toEqual(['b'])
	})

	test('defaults the validation expectations', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: [] }, ['a'])
		const validation = loadSuite({ fs: memory.fs }, '/suite').benchmarks['a']?.validation
		expect(validation?.expectedExitCode).toBe(0)
		expect(validation?.expectedFiles).toEqual([])
		expect(validation?.timeoutSeconds).toBe(120)
	})

	test('rejects a benchmark listed in neither split', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: [] }, ['a', 'b'])
		expect(captureValidationError(() => loadSuite({ fs: memory.fs }, '/suite')).message).toContain(
			'benchmark "b" is in neither split',
		)
	})

	test('rejects a benchmark listed in both splits', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: ['a'] }, ['a'])
		expect(captureValidationError(() => loadSuite({ fs: memory.fs }, '/suite')).message).toContain(
			'"a" is listed in both splits',
		)
	})

	test('rejects a split naming a directory that does not exist', () => {
		const memory = buildSuite({ optimization: ['a', 'ghost'], heldOut: [] }, ['a'])
		expect(captureValidationError(() => loadSuite({ fs: memory.fs }, '/suite')).message).toContain(
			'"ghost" is listed in optimization but is not a benchmark directory',
		)
	})

	test('rejects a spec whose id does not match its directory', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: [] }, ['a'])
		memory.files.set('/suite/a/spec.json', spec('something-else'))
		expect(captureValidationError(() => loadSuite({ fs: memory.fs }, '/suite')).message).toContain(
			'does not match its directory name',
		)
	})

	test('rejects a missing suite.json', () => {
		const memory = createMemoryFileSystem({}, ['/suite'])
		expect(captureValidationError(() => loadSuite({ fs: memory.fs }, '/suite')).path).toBe('/suite/suite.json')
	})
})

describe('selectSplit', () => {
	test('returns only the requested half', () => {
		const memory = buildSuite({ optimization: ['a'], heldOut: ['b'] }, ['a', 'b'])
		const suite = loadSuite({ fs: memory.fs }, '/suite')

		expect(selectSplit(suite, 'optimization')).toEqual(['a'])
		expect(selectSplit(suite, 'held-out')).toEqual(['b'])
	})
})
