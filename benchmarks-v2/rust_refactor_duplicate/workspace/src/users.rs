/// The amount a user is owed, as a decimal string.
pub fn amount(cents: i64) -> String {
	format!("{}.{:02}", cents / 100, cents % 100)
}