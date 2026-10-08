/// The integers from 0 up to (but not including) `count`.
pub fn range(count: u32) -> Vec<u32> {
	let mut values = Vec::new();
	for index in 0..=count {
		values.push(index);
	}
	values
}