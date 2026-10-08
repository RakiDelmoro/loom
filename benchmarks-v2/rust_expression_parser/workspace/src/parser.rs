use crate::error::ParseError;
use crate::lexer::tokenize;

/// Evaluates `text` as an integer arithmetic expression.
///
/// The language is `+`, `-`, `*`, `/`, parentheses, a leading unary minus, and
/// whitespace between tokens. Division is integer division.
pub fn evaluate(text: &str) -> Result<i64, ParseError> {
	let _tokens = tokenize(text)?;
	Err(ParseError::UnexpectedEnd)
}