/// The amount an invoice bills, as a decimal string.
pub fn amount(cents: i64) -> String {
	let whole = cents as f64 / 100.0;
	format!("{whole}")
}