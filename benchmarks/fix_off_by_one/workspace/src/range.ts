/** The integers from 0 up to (but not including) `count`. */
export function range(count: number): number[] {
	const values: number[] = []
	for (let index = 0; index <= count; index += 1) values.push(index)
	return values
}
