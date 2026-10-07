import { describe, expect, test } from 'bun:test'
import { parseArguments } from './cli-args.ts'

describe('parseArguments', () => {
	test('collects positionals', () => {
		expect(parseArguments(['status', 'run-1'], []).positionals).toEqual(['status', 'run-1'])
	})

	test('reads a flag and its value', () => {
		const parsed = parseArguments(['--task', 'write a file', '--repo', '/tmp/x'], [])
		expect(parsed.flags['task']).toBe('write a file')
		expect(parsed.flags['repo']).toBe('/tmp/x')
		expect(parsed.positionals).toEqual([])
	})

	test('records a declared switch without consuming the next token', () => {
		const parsed = parseArguments(['run-1', '--branches', '--repo', '/tmp/x'], ['branches'])
		expect(parsed.switches).toEqual(['branches'])
		expect(parsed.positionals).toEqual(['run-1'])
		expect(parsed.flags['repo']).toBe('/tmp/x')
	})

	test('treats a flag with no value as empty rather than swallowing the next flag', () => {
		const parsed = parseArguments(['--agent', '--repo', '/tmp/x'], [])
		expect(parsed.flags['agent']).toBe('')
		expect(parsed.flags['repo']).toBe('/tmp/x')
	})

	test('treats a trailing flag with no value as empty', () => {
		expect(parseArguments(['--agent'], []).flags['agent']).toBe('')
	})

	test('keeps the values of repeated flags last-wins', () => {
		expect(parseArguments(['--repo', '/a', '--repo', '/b'], []).flags['repo']).toBe('/b')
	})
})
