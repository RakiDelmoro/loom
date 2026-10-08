use binary_search::{lower_bound, upper_bound};

#[test]
fn brackets_a_value_that_is_present() {
	let values = [1, 3, 5, 7];
	assert_eq!(lower_bound(&values, 5), 2);
	assert_eq!(upper_bound(&values, 5), 3);
}

#[test]
fn brackets_a_value_that_is_absent() {
	let values = [1, 3, 5, 7];
	assert_eq!(lower_bound(&values, 4), 2);
	assert_eq!(upper_bound(&values, 4), 2);
}

#[test]
fn brackets_the_whole_run_of_a_repeated_value() {
	let values = [1, 2, 2, 2, 3];
	assert_eq!(lower_bound(&values, 2), 1);
	assert_eq!(upper_bound(&values, 2), 4);
}

#[test]
fn a_value_below_everything_brackets_the_start() {
	let values = [1, 2, 3];
	assert_eq!(lower_bound(&values, 0), 0);
	assert_eq!(upper_bound(&values, 0), 0);
}

#[test]
fn a_value_above_everything_brackets_the_end() {
	let values = [1, 2, 3];
	assert_eq!(lower_bound(&values, 4), 3);
	assert_eq!(upper_bound(&values, 4), 3);
}

#[test]
fn an_empty_slice_brackets_nothing() {
	let values: [i32; 0] = [];
	assert_eq!(lower_bound(&values, 1), 0);
	assert_eq!(upper_bound(&values, 1), 0);
}