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
import type { RunManifest } from './types.ts'
import { parseRunManifest } from './validate.ts'

const RUNS_DIRECTORY = '.loom/runs'
const MANIFEST_FILE = 'run.json'
const EVENTS_FILE = 'events.jsonl'

export interface RunStoreDependencies {
	readonly fs: FileSystem
	readonly now: () => number
}

export interface RunStore {
	runDirectory(runId: string): string
	writeManifest(runId: string, manifest: RunManifest): void
	readManifest(runId: string): RunManifest | null
	appendEvent(runId: string, event: RunEvent): void
	listRunIds(): readonly string[]
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
			fs.writeTextFile(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`)
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
			fs.appendTextFile(path.join(directory, EVENTS_FILE), `${JSON.stringify(logLine(event, at))}\n`)
		},

		listRunIds(): readonly string[] {
			const listed = fs.listDirectory(runsRoot)
			if (listed.kind !== 'ok') return []
			return listed.entries
				.filter((entry) => entry.isDirectory)
				.map((entry) => entry.name)
				.sort()
		},
	}
}
