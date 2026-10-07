import { expect, test } from 'bun:test'
import { runAll, type Job } from './batch.ts'

function ok(name: string, value: string): Job {
	return { name, run: () => value }
}

function boom(name: string, reason: string): Job {
	return {
		name,
		run: () => {
			throw new Error(reason)
		},
	}
}

test('collects what each job produced', () => {
	const report = runAll([ok('a', 'one'), ok('b', 'two')])
	expect(report.results).toEqual(['one', 'two'])
	expect(report.failures).toEqual([])
})

test('a failing job is named, and the jobs after it still run', () => {
	const report = runAll([ok('a', 'one'), boom('b', 'disk full'), ok('c', 'three')])
	expect(report.results).toEqual(['one', 'three'])
	expect(report.failures).toEqual(['b: disk full'])
})

test('a failure does not escape to the caller', () => {
	expect(() => runAll([boom('b', 'disk full')])).not.toThrow()
})

test('every failing job is reported, in order', () => {
	const report = runAll([boom('a', 'first'), ok('b', 'two'), boom('c', 'second')])
	expect(report.failures).toEqual(['a: first', 'c: second'])
	expect(report.results).toEqual(['two'])
})
