/// The amount an order totals, as a decimal string.
pub fn amount(cents: i64) -> String {
	format!("{}.{}", cents / 100, (cents % 100).abs())
}