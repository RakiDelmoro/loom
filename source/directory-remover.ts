/**
 * The directory-removal leaf.
 *
 * Copying a guild is done file by file through the `FileSystem` — the files are
 * exactly the ones the Blueprint *references*, so a branch never sweeps up the
 * repository around it. Removing a branch tree is the one operation that cannot
 * be expressed file by file.
 */

import { rmSync } from 'node:fs'

export type RemoveDirectory = (directory: string) => void

export function createDirectoryRemover(): RemoveDirectory {
	return (directory) => {
		rmSync(directory, { recursive: true, force: true })
	}
}
