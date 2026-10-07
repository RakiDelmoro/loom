import { expect, test } from 'bun:test'
import { rank, type Row } from './rank.ts'

function row(name: string, score: number): Row {
	return { name, score }
}

test('higher scores come first', () => {
	const ordered = rank([row('a', 1), row('b', 3), row('c', 2)])
	expect(ordered.map((entry) => entry.name)).toEqual(['b', 'c', 'a'])
})

test('rows with equal scores are ordered by name, ascending', () => {
	const ordered = rank([row('bea', 1), row('ann', 1), row('cyd', 0)])
	expect(ordered.map((entry) => entry.name)).toEqual(['ann', 'bea', 'cyd'])
})

test('the order does not depend on the order the rows arrive in', () => {
	const forwards = rank([row('ann', 2), row('bea', 2), row('cyd', 2)])
	const backwards = rank([row('cyd', 2), row('bea', 2), row('ann', 2)])
	expect(forwards.map((entry) => entry.name)).toEqual(['ann', 'bea', 'cyd'])
	expect(backwards.map((entry) => entry.name)).toEqual(['ann', 'bea', 'cyd'])
})

test('the rows that were passed in are not modified', () => {
	const rows = [row('b', 1), row('a', 1)]
	rank(rows)
	expect(rows.map((entry) => entry.name)).toEqual(['b', 'a'])
})
