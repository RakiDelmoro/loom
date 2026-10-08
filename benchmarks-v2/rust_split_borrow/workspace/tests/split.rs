use split_borrow::first_and_last;

#[test]
fn writes_through_both_handles() {
	let mut values = [1, 2, 3];
	let (first, last) = first_and_last(&mut values);
	*first += 10;
	*last += 100;
	assert_eq!(values, [11, 2, 103]);
}

#[test]
fn a_pair_writes_through_both_handles() {
	let mut values = [1, 2];
	let (first, last) = first_and_last(&mut values);
	*first += 10;
	*last += 100;
	assert_eq!(values, [11, 102]);
}

#[test]
#[should_panic]
fn a_single_element_has_no_last_element() {
	let mut values = [7];
	let _ = first_and_last(&mut values);
}