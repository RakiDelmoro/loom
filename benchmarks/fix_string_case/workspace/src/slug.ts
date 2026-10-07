/** A lower-case, dash-separated form of `title`. */
export function slug(title: string): string {
	return title.trim().replace(/\s+/g, '-').toUpperCase()
}
