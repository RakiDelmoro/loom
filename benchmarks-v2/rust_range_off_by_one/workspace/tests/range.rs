use range::range;

#[test]
fn starts_at_zero_and_excludes_the_count() {
	assert_eq!(range(3), vec![0, 1, 2]);
}

#[test]
fn an_empty_range_is_empty() {
	assert_eq!(range(0), Vec::<u32>::new());
}

#[test]
fn a_single_element_range_holds_only_zero() {
	assert_eq!(range(1), vec![0]);
}