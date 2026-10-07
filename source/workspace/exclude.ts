/**
 * Keeping `.loom/` out of the repository's git view.
 *
 * The bookkeeping directory is written to `.git/info/exclude` rather than
 * `.gitignore`, because `.gitignore` is a tracked file the operator owns and
 * Loom has no business editing it. The exclude file is local by design.
 *
 * This is visibility hygiene, not containment: it keeps run artefacts out of
 * `git status` and out of an accidental commit. It is best-effort — a repository
 * Loom cannot resolve is reported as `skipped`, never as a failure, because a
 * cosmetic problem must not stop a run.
 */

import * as path from 'node:path'
import type { ReadTextFileResult } from '../fs.ts'
import { EXCLUDE_ENTRY } from './naming.ts'

export type ExcludeResult =
	| { readonly kind: 'ok'; readonly updated: boolean }
	| { readonly kind: 'skipped'; readonly reason: string }

export interface ExcludeDependencies {
	readonly readTextFile: (filePath: string) => ReadTextFileResult
	readonly writeTextFile: (filePath: string, text: string) => void
	readonly isDirectory: (dirPath: string) => boolean
	readonly ensureDirectory: (dirPath: string) => void
}

/**
 * Reads the `gitdir:` pointer out of a linked worktree's `.git` file. A normal
 * checkout has a `.git` directory instead, which has no pointer to read.
 */
export function gitDirFromLinkFile(text: string): string | null {
	for (const line of text.split('\n')) {
		const match = /^gitdir:\s*(\S.*)$/.exec(line)
		if (match === null) continue
		const target = match[1]
		if (target !== undefined && target.trim() !== '') return target.trim()
	}
	return null
}

/**
 * The exclude file's new contents, or `null` when the entry is already present.
 * An existing entry is never rewritten, so Loom does not churn a file it shares
 * with the operator.
 */
export function appendExcludeEntry(text: string, entry: string): string | null {
	const alreadyPresent = text.split('\n').some((line) => line.trim() === entry)
	if (alreadyPresent) return null
	const separator = text === '' || text.endsWith('\n') ? '' : '\n'
	return `${text}${separator}${entry}\n`
}

/** Ensures `.loom/` is excluded from `git status` for the repository at `repoPath`. */
export function ensureOrchestrationExcluded(dependencies: ExcludeDependencies, repoPath: string): ExcludeResult {
	const dotGit = path.join(repoPath, '.git')

	let gitDir = dotGit
	if (!dependencies.isDirectory(dotGit)) {
		const link = dependencies.readTextFile(dotGit)
		if (link.kind !== 'ok') return { kind: 'skipped', reason: `${repoPath} is not a git checkout` }
		const target = gitDirFromLinkFile(link.text)
		if (target === null) return { kind: 'skipped', reason: `${dotGit} is a file with no gitdir pointer` }
		gitDir = path.isAbsolute(target) ? target : path.resolve(repoPath, target)
	}

	const excludePath = path.join(gitDir, 'info', 'exclude')
	const existing = dependencies.readTextFile(excludePath)
	const next = appendExcludeEntry(existing.kind === 'ok' ? existing.text : '', EXCLUDE_ENTRY)
	if (next === null) return { kind: 'ok', updated: false }

	dependencies.ensureDirectory(path.join(gitDir, 'info'))
	dependencies.writeTextFile(excludePath, next)
	return { kind: 'ok', updated: true }
}
