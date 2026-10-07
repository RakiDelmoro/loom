import { describe, expect, test } from 'bun:test'
import { resolveWorkspacePath, toRelativePath } from './path.ts'

describe('resolveWorkspacePath', () => {
	test('resolves a path inside the workspace', () => {
		expect(resolveWorkspacePath('/repo', 'src/a.ts')).toEqual({ kind: 'ok', path: '/repo/src/a.ts' })
	})

	test('resolves the workspace root itself', () => {
		expect(resolveWorkspacePath('/repo', '.')).toEqual({ kind: 'ok', path: '/repo' })
	})

	test('refuses a path that climbs out of the workspace', () => {
		expect(resolveWorkspacePath('/repo', '../secrets').kind).toBe('outside')
		expect(resolveWorkspacePath('/repo', 'src/../../etc/passwd').kind).toBe('outside')
	})

	test('refuses an absolute path outside the workspace', () => {
		expect(resolveWorkspacePath('/repo', '/etc/passwd').kind).toBe('outside')
	})

	test('allows an absolute path that is inside the workspace', () => {
		expect(resolveWorkspacePath('/repo', '/repo/src/a.ts')).toEqual({ kind: 'ok', path: '/repo/src/a.ts' })
	})

	test('refuses a sibling directory sharing the workspace prefix', () => {
		// `/repo-other` starts with `/repo` as a string but is not inside it.
		expect(resolveWorkspacePath('/repo', '../repo-other/a').kind).toBe('outside')
	})
})

describe('toRelativePath', () => {
	test('returns a slash-separated path relative to the workspace', () => {
		expect(toRelativePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
	})
})
