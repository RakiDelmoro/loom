/**
 * Parsing a model's hypotheses.
 *
 * Strict, like every other external document: an edit that names a path outside
 * the guild directory, or a change with no content, is rejected before it can
 * touch a branch directory.
 */

import { expectNonEmptyString, expectRecord, fail, rejectUnknownKeys } from '../validation.ts'
import type { BlueprintChange, Hypothesis } from './types.ts'

const HYPOTHESIS_KEYS = ['id', 'motivation', 'mechanism', 'predictedImpact', 'changes'] as const
const CHANGE_KEYS = ['path', 'content'] as const

/**
 * A path a change may name. Rejected if absolute or if any segment climbs out —
 * a hypothesis is untrusted text from a model, and it edits a directory.
 */
export function isSafeChangePath(path: string): boolean {
	if (path === '' || path.startsWith('/') || path.startsWith('\\')) return false
	if (/^[A-Za-z]:/.test(path)) return false
	return path.split(/[\\/]/).every((segment) => segment !== '..' && segment !== '')
}

function parseChange(value: unknown, path: string): BlueprintChange {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, CHANGE_KEYS, path)

	const target = expectNonEmptyString(record['path'], `${path}.path`)
	if (!isSafeChangePath(target)) fail(`${path}.path`, `"${target}" is not a path inside the guild directory`)

	return { path: target, content: expectNonEmptyString(record['content'], `${path}.content`) }
}

function parseHypothesis(value: unknown, path: string): Hypothesis {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, HYPOTHESIS_KEYS, path)

	if (!Array.isArray(record['changes'])) fail(`${path}.changes`, 'expected an array')
	const changes = record['changes'].map((change, index) => parseChange(change, `${path}.changes[${index}]`))
	if (changes.length === 0) fail(`${path}.changes`, 'a hypothesis must change something')

	return {
		id: expectNonEmptyString(record['id'], `${path}.id`),
		motivation: expectNonEmptyString(record['motivation'], `${path}.motivation`),
		mechanism: expectNonEmptyString(record['mechanism'], `${path}.mechanism`),
		predictedImpact: expectNonEmptyString(record['predictedImpact'], `${path}.predictedImpact`),
		changes,
	}
}

/**
 * Reads the hypothesis array out of a model's reply.
 *
 * Throws rather than returning a partial list: one malformed hypothesis means
 * the reply is not trustworthy, and silently dropping it would hide a prompt
 * problem behind a plausible-looking cycle.
 */
export function parseHypotheses(value: unknown, path = 'hypotheses'): Hypothesis[] {
	if (!Array.isArray(value)) fail(path, 'expected an array of hypotheses')
	return value.map((entry, index) => parseHypothesis(entry, `${path}[${index}]`))
}

/** Exported so the shape the parser expects is readable in one place. */
export const HYPOTHESIS_FIELDS = ['id', 'motivation', 'mechanism', 'predictedImpact', 'changes'] as const
