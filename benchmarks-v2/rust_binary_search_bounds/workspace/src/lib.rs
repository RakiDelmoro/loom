/// The index of the first element that is not less than `target`.
///
/// `values` must be sorted. Returns `values.len()` when every element is less
/// than `target`.
pub fn lower_bound(values: &[i32], target: i32) -> usize {
	let mut low = 0;
	let mut high = values.len();
	while low < high {
		let middle = (low + high) / 2;
		if values[middle] < target {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	low
}

/// The index of the first element that is greater than `target`.
///
/// `values` must be sorted. Returns `values.len()` when every element is at most
/// `target`.
pub fn upper_bound(values: &[i32], target: i32) -> usize {
	let mut low = 0;
	let mut high = values.len();
	while low < high {
		let middle = (low + high) / 2;
		if values[middle] < target {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	low
}