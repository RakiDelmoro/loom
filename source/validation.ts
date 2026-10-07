/**
 * The shared validation vocabulary.
 *
 * Every external document Loom reads — a Blueprint, a deployment file — is
 * parsed through these helpers, so a bad field is reported the same way
 * everywhere: a `ValidationError` naming the exact JSON path, and unknown keys
 * rejected at every level so a typo fails loudly instead of being ignored.
 *
 * These are a small vocabulary rather than one-line renames: each encodes a
 * policy (non-empty, positive, finite, path-tagged) that dozens of call sites
 * must apply identically.
 */

import { ValidationError } from './errors.ts'
import { isRecord } from './guards.ts'

/** Throws a path-carrying error. Declared `never` so it narrows at call sites. */
export function fail(path: string, message: string): never {
	throw new ValidationError(path, message)
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, 'expected an object')
	return value
}

export function expectNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== 'string' || value === '') fail(path, 'expected a non-empty string')
	return value
}

export function expectNumber(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number')
	return value
}

export function expectNonNegativeNumber(value: unknown, path: string): number {
	const parsed = expectNumber(value, path)
	if (parsed < 0) fail(path, 'expected a number greater than or equal to zero')
	return parsed
}

export function expectPositiveInteger(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(path, 'expected a positive integer')
	return value
}

export function expectStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, 'expected an array')
	return value.map((item, index) => expectNonEmptyString(item, `${path}[${index}]`))
}

export function expectEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
	const expected = `expected one of ${allowed.join(', ')}`
	if (typeof value !== 'string') fail(path, expected)
	for (const option of allowed) {
		if (value === option) return option
	}
	fail(path, expected)
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown key')
	}
}
