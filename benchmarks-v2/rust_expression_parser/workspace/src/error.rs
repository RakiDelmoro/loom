/// Why an expression could not be evaluated.
#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
	/// A character that is not part of the language, and where it was found.
	UnexpectedCharacter { character: char, offset: usize },
	/// A token that does not fit where it was found, with the text it was read
	/// from and the offset it started at.
	UnexpectedToken { text: String, offset: usize },
	/// The input stopped in the middle of an expression.
	UnexpectedEnd,
	/// A division whose right-hand side is zero.
	DivisionByZero,
}