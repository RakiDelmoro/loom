export interface Row {
	readonly name: string
	readonly score: number
}

/** Orders rows by score, highest first. Rows with the same score keep a predictable order. */
export function rank(rows: readonly Row[]): Row[] {
	return [...rows].sort((left, right) => right.score - left.score)
}
