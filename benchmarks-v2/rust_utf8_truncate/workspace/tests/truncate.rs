use utf8_truncate::truncate;

#[test]
fn keeps_a_string_that_already_fits() {
	assert_eq!(truncate("hello", 10), "hello");
}

#[test]
fn cuts_where_a_character_ends() {
	assert_eq!(truncate("héllo", 3), "hé");
}

#[test]
fn steps_back_to_a_boundary_rather_than_panicking() {
	// The `é` is two bytes, so byte 2 falls inside it.
	assert_eq!(truncate("héllo", 2), "h");
}

#[test]
fn a_wide_character_can_leave_nothing() {
	// The emoji is four bytes, so byte 2 falls inside it.
	assert_eq!(truncate("🙂x", 2), "");
}

#[test]
fn zero_is_the_empty_prefix() {
	assert_eq!(truncate("héllo", 0), "");
}