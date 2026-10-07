/**
 * The run store: where a run's record lives on disk.
 *
 * ```
 * <repo>/.loom/runs/<runId>/
 * ├── run.json      the manifest — rewritten as the run progresses
 * └── events.jsonl  the event log — appended to, never rewritten
 * ```
 *
 * The two files are written differently on purpose. The manifest is a summary
 * that must be complete and current, so it is replaced wholesale. The log is
 * history, so it is only ever appended to — which is what lets it stay truthful
 * when a run is killed mid-flight.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import { logLine, type RunEvent } from './events.ts'
import type { Redact } from '../redact.ts'
import type { RunManifest } from './types.ts'
import { parseRunLogLine, parseRunManifest, type RunLogRecord } from './validate.ts'

const RUNS_DIRECTORY = '.loom/runs'
const MANIFEST_FILE = 'run.json'
const EVENTS_FILE = 'events.jsonl'
const OWNER_FILE = 'owner.json'

/**
 * The process a run belongs to.
 *
 * A manifest saying `running` is only true while the process that wrote it is
 * alive: a run cannot be finished by anyone else, and a reader — a second UI on
 * the same project, say — has no way to tell a slow run from an abandoned one
 * without asking. This is that question's answer, and the reason a reader must
 * never mark a run interrupted on its own authority.
 */
export interface RunOwner {
	readonly pid: number
}

export interface RunStoreDependencies {
	readonly fs: FileSystem
	readonly now: () => number
	/**
	 * Applied to every line written. A run's record describes untrusted content,
	 * and a workspace file can contain a credential — so the log is where a secret
	 * would otherwise end up.
	 */
	readonly redact: Redact
}

export interface RunStore {
	runDirectory(runId: string): string
	writeManifest(runId: string, manifest: RunManifest): void
	readManifest(runId: string): RunManifest | null
	appendEvent(runId: string, event: RunEvent): void
	/** Records which process is running this run. */
	writeOwner(runId: string, owner: RunOwner): void
	readOwner(runId: string): RunOwner | null
	listRunIds(): readonly string[]
	readEvents(runId: string): readonly RunLogRecord[]
}

export function createRunStore(dependencies: RunStoreDependencies, options: { readonly repoPath: string }): RunStore {
	const { fs } = dependencies
	const runsRoot = path.join(options.repoPath, RUNS_DIRECTORY)

	function runDirectory(runId: string): string {
		return path.join(runsRoot, runId)
	}

	return {
		runDirectory,

		writeManifest(runId: string, manifest: RunManifest): void {
			const directory = runDirectory(runId)
			fs.ensureDirectory(directory)
			const text = `${JSON.stringify(manifest, null, '\t')}\n`
			fs.writeTextFile(path.join(directory, MANIFEST_FILE), dependencies.redact(text))
		},

		readManifest(runId: string): RunManifest | null {
			const read = fs.readTextFile(path.join(runDirectory(runId), MANIFEST_FILE))
			if (read.kind !== 'ok') return null

			let parsed: unknown
			try {
				parsed = JSON.parse(read.text)
			} catch {
				return null
			}
			return parseRunManifest(parsed)
		},

		appendEvent(runId: string, event: RunEvent): void {
			const directory = runDirectory(runId)
			fs.ensureDirectory(directory)
			const at = new Date(dependencies.now()).toISOString()
			const line = `${JSON.stringify(logLine(event, at))}\n`
			fs.appendTextFile(path.join(directory, EVENTS_FILE), dependencies.redact(line))
		},

		writeOwner(runId: string, owner: RunOwner): void {
			const directory = runDirectory(runId)
			fs.ensureDirectory(directory)
			fs.writeTextFile(path.join(directory, OWNER_FILE), `${JSON.stringify(owner)}\n`)
		},

		readOwner(runId: string): RunOwner | null {
			const read = fs.readTextFile(path.join(runDirectory(runId), OWNER_FILE))
			if (read.kind !== 'ok') return null
			let parsed: unknown
			try {
				parsed = JSON.parse(read.text)
			} catch {
				return null
			}
			if (typeof parsed !== 'object' || parsed === null) return null
			const pid = (parsed as { readonly pid?: unknown }).pid
			return typeof pid === 'number' ? { pid } : null
		},

		listRunIds(): readonly string[] {
			const listed = fs.listDirectory(runsRoot)
			if (listed.kind !== 'ok') return []
			return listed.entries
				.filter((entry) => entry.isDirectory)
				.map((entry) => entry.name)
				.sort()
		},

		readEvents(runId: string): readonly RunLogRecord[] {
			const read = fs.readTextFile(path.join(runDirectory(runId), EVENTS_FILE))
			if (read.kind !== 'ok') return []

			const records: RunLogRecord[] = []
			for (const line of read.text.split('\n')) {
				if (line.trim() === '') continue
				let parsed: unknown
				try {
					parsed = JSON.parse(line)
				} catch {
					// A torn or hand-edited line is skipped rather than failing the read:
					// the rest of the log is still worth showing.
					continue
				}
				const record = parseRunLogLine(parsed, records.length)
				if (record !== null) records.push(record)
			}
			return records
		},
	}
}
