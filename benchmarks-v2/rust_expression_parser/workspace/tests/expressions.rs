use expressions::{evaluate, ParseError};

#[test]
fn reads_a_single_number() {
	assert_eq!(evaluate("7"), Ok(7));
	assert_eq!(evaluate("  7  "), Ok(7));
}

#[test]
fn multiplies_before_it_adds() {
	assert_eq!(evaluate("1 + 2 * 3"), Ok(7));
	assert_eq!(evaluate("2 * 3 + 1"), Ok(7));
}

#[test]
fn parentheses_win() {
	assert_eq!(evaluate("(1 + 2) * 3"), Ok(9));
	assert_eq!(evaluate("2 * (3 + 4)"), Ok(14));
}

#[test]
fn subtraction_and_division_are_left_associative() {
	assert_eq!(evaluate("10 - 3 - 2"), Ok(5));
	assert_eq!(evaluate("100 / 5 / 2"), Ok(10));
}

#[test]
fn a_leading_minus_negates() {
	assert_eq!(evaluate("-5 + 8"), Ok(3));
	assert_eq!(evaluate("-(2 + 3)"), Ok(-5));
}

#[test]
fn an_unknown_character_is_reported_where_it_is() {
	assert_eq!(
		evaluate("1 $ 2"),
		Err(ParseError::UnexpectedCharacter {
			character: '$',
			offset: 2
		})
	);
}

#[test]
fn an_expression_that_stops_early_is_an_end() {
	assert_eq!(evaluate(""), Err(ParseError::UnexpectedEnd));
	assert_eq!(evaluate("1 +"), Err(ParseError::UnexpectedEnd));
	assert_eq!(evaluate("(1 + 2"), Err(ParseError::UnexpectedEnd));
}

#[test]
fn a_stray_closing_parenthesis_is_reported_where_it_is() {
	assert_eq!(
		evaluate("1 + 2)"),
		Err(ParseError::UnexpectedToken {
			text: ")".to_string(),
			offset: 5
		})
	);
}

#[test]
fn division_by_zero_is_its_own_error() {
	assert_eq!(evaluate("1 / 0"), Err(ParseError::DivisionByZero));
}