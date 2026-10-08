/// The longest prefix of `text` that is at most `limit` bytes long.
pub fn truncate(text: &str, limit: usize) -> &str {
	&text[..limit]
}