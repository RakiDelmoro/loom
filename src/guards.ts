/**
 * The package's canonical type-guard module.
 *
 * `isRecord` is defined here once and imported wherever an external value's
 * shape is uncertain. It proves only that a value is a plain object — never what
 * its fields are — so callers still check each field they read.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
