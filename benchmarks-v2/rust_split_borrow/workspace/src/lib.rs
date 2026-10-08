/// Handles to the first and the last element of `values`.
///
/// Panics when `values` has fewer than two elements.
pub fn first_and_last(values: &mut [i32]) -> (&mut i32, &mut i32) {
	let last = values.len() - 1;
	(&mut values[0], &mut values[last])
}