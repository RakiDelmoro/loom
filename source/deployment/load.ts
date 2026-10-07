/**
 * Loading the deployment file.
 *
 * Orchestration, not a leaf: the filesystem is injected, so the whole loader is
 * exercised in memory by the tests.
 */

import { ValidationError } from '../errors.ts'
import type { ReadTextFileResult } from '../fs.ts'
import { parseDeployment } from './parse.ts'
import type { Deployment } from './types.ts'

export interface DeploymentLoaderDependencies {
	readonly readTextFile: (filePath: string) => ReadTextFileResult
}

export function loadDeployment(dependencies: DeploymentLoaderDependencies, deploymentPath: string): Deployment {
	const read = dependencies.readTextFile(deploymentPath)
	if (read.kind !== 'ok') throw new ValidationError(deploymentPath, read.message)

	let parsed: unknown
	try {
		parsed = JSON.parse(read.text)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new ValidationError(deploymentPath, `not valid JSON: ${detail}`)
	}

	return parseDeployment(parsed, deploymentPath)
}
