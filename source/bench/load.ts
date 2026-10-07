/**
 * Loading a suite and splitting it.
 *
 * The split is where the anti-overfitting guarantee lives, so it is checked
 * rather than trusted: every benchmark directory must appear in exactly one of
 * the two lists. A benchmark that quietly belonged to neither would be silently
 * untested; one in both would be silently optimizable.
 */

import * as path from 'node:path'
import { ValidationError } from '../errors.ts'
import type { FileSystem } from '../fs.ts'
import { parseBenchmarkSpec, parseSuiteConfig } from './parse.ts'
import type { BenchmarkSpec, Split, SuiteConfig } from './types.ts'

export interface LoadedSuite {
	readonly suitePath: string
	readonly benchmarks: Readonly<Record<string, BenchmarkSpec>>
	readonly config: SuiteConfig
}

export interface SuiteLoaderDependencies {
	readonly fs: FileSystem
}

export function loadSuite(dependencies: SuiteLoaderDependencies, suitePath: string): LoadedSuite {
	const config = parseSuiteConfig(readJson(dependencies.fs, path.join(suitePath, 'suite.json')), 'suite.json')

	const listed = dependencies.fs.listDirectory(suitePath)
	if (listed.kind !== 'ok') throw new ValidationError(suitePath, listed.message)
	const directories = listed.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name).sort()

	const benchmarks: Record<string, BenchmarkSpec> = {}
	for (const name of directories) {
		const specPath = path.join(suitePath, name, 'spec.json')
		const spec = parseBenchmarkSpec(readJson(dependencies.fs, specPath), `${name}/spec.json`)
		if (spec.id !== name) {
			throw new ValidationError(`${name}/spec.json.id`, `id "${spec.id}" does not match its directory name "${name}"`)
		}
		benchmarks[name] = spec
	}

	requirePartition(config, directories)
	return { suitePath, benchmarks, config }
}

/** Every benchmark directory belongs to exactly one split. */
function requirePartition(config: SuiteConfig, directories: readonly string[]): void {
	const known = new Set(directories)
	const claimed = new Set<string>()

	for (const split of ['optimization', 'heldOut'] as const) {
		for (const name of config[split]) {
			if (!known.has(name)) throw new ValidationError('suite.json', `"${name}" is listed in ${split} but is not a benchmark directory`)
			if (claimed.has(name)) throw new ValidationError('suite.json', `"${name}" is listed in both splits`)
			claimed.add(name)
		}
	}

	for (const name of directories) {
		if (!claimed.has(name)) throw new ValidationError('suite.json', `benchmark "${name}" is in neither split`)
	}
}

/**
 * The benchmarks one split may run.
 *
 * The optimizer is only ever handed the result of an `optimization` run; a
 * `held-out` run is a separate step whose inputs it never sees.
 */
export function selectSplit(suite: LoadedSuite, split: Split): readonly string[] {
	return split === 'optimization' ? suite.config.optimization : suite.config.heldOut
}

function readJson(fs: FileSystem, filePath: string): unknown {
	const read = fs.readTextFile(filePath)
	if (read.kind !== 'ok') throw new ValidationError(filePath, read.message)
	try {
		return JSON.parse(read.text)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new ValidationError(filePath, `not valid JSON: ${detail}`)
	}
}
