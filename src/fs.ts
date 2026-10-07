/**
 * The filesystem boundary.
 *
 * Leaves report what happened as a value rather than throwing, so the caller
 * decides what a missing file means. `FileSystem` describes the whole boundary;
 * a module takes only the subset it uses, since structural typing makes a
 * superset assignable to a subset.
 */

export type ReadTextFileResult =
	| { readonly kind: 'ok'; readonly text: string }
	| { readonly kind: 'unreadable'; readonly message: string }

export interface FileSystem {
	readonly readTextFile: (filePath: string) => ReadTextFileResult
	readonly writeTextFile: (filePath: string, text: string) => void
	readonly isDirectory: (dirPath: string) => boolean
	readonly ensureDirectory: (dirPath: string) => void
}
