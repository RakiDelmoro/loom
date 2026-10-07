import { describe, expect, test } from 'bun:test'
import { parseArguments, parseModelOverrides } from './cli-args.ts'

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

	test('collects a declared repeatable flag into a list, in order', () => {
		const parsed = parseArguments(['--model-override', 'a=b', '--model-override', 'c=d'], [], ['model-override'])
		expect(parsed.repeated['model-override']).toEqual(['a=b', 'c=d'])
	})

	test('records an empty entry for a repeatable flag with no value', () => {
		expect(parseArguments(['--model-override'], [], ['model-override']).repeated['model-override']).toEqual([''])
	})

	test('leaves the repeated map empty when nothing repeats', () => {
		expect(parseArguments(['run'], [], ['model-override']).repeated).toEqual({})
	})
})

describe('parseModelOverrides', () => {
	test('parses role=profile pairs', () => {
		expect(parseModelOverrides(['coder=reasoner', 'planner=worker'])).toEqual({
			kind: 'ok',
			value: { coder: 'reasoner', planner: 'worker' },
		})
	})

	test('rejects a pair with no separator', () => {
		expect(parseModelOverrides(['coder']).kind).toBe('failed')
	})

	test('rejects a pair with an empty side', () => {
		expect(parseModelOverrides(['=reasoner']).kind).toBe('failed')
		expect(parseModelOverrides(['coder=']).kind).toBe('failed')
	})

	test('a profile name may itself contain an equals sign', () => {
		expect(parseModelOverrides(['coder=a=b'])).toEqual({ kind: 'ok', value: { coder: 'a=b' } })
	})

	test('an empty list yields an empty override map', () => {
		expect(parseModelOverrides([])).toEqual({ kind: 'ok', value: {} })
	})
})
