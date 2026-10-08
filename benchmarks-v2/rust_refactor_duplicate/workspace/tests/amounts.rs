use refactor_amounts::{invoices, money, orders, users};

#[test]
fn every_entry_point_formats_a_value_the_same_way() {
	for cents in [0, 5, 99, 100, 1234, -5, -1234] {
		let expected = canonical(cents);
		assert_eq!(users::amount(cents), expected, "users disagreed at {cents}");
		assert_eq!(orders::amount(cents), expected, "orders disagreed at {cents}");
		assert_eq!(invoices::amount(cents), expected, "invoices disagreed at {cents}");
		assert_eq!(money::amount(cents), expected, "money disagreed at {cents}");
	}
}

/// The rule the entry points have to agree on.
fn canonical(cents: i64) -> String {
	let sign = if cents < 0 { "-" } else { "" };
	let magnitude = cents.unsigned_abs();
	format!("{sign}{}.{:02}", magnitude / 100, magnitude % 100)
}