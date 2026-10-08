use crate::error::ParseError;

/// A token, with the byte offset it started at.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Token {
	Number(i64),
	Plus,
	Minus,
	Star,
	Slash,
	Open,
	Close,
	/// The end of the input.
	End,
}

impl Token {
	/// The text a token was read from, for an error message.
	pub fn text(&self) -> String {
		match self {
			Token::Number(value) => value.to_string(),
			Token::Plus => "+".to_string(),
			Token::Minus => "-".to_string(),
			Token::Star => "*".to_string(),
			Token::Slash => "/".to_string(),
			Token::Open => "(".to_string(),
			Token::Close => ")".to_string(),
			Token::End => "the end of the input".to_string(),
		}
	}
}

/// Splits `text` into tokens, always terminated by `Token::End`.
pub fn tokenize(text: &str) -> Result<Vec<(Token, usize)>, ParseError> {
	let characters: Vec<(usize, char)> = text.char_indices().collect();
	let mut tokens = Vec::new();
	let mut index = 0;

	while index < characters.len() {
		let (offset, character) = characters[index];

		if character.is_whitespace() {
			index += 1;
			continue;
		}

		let punctuation = match character {
			'+' => Some(Token::Plus),
			'-' => Some(Token::Minus),
			'*' => Some(Token::Star),
			'/' => Some(Token::Slash),
			'(' => Some(Token::Open),
			')' => Some(Token::Close),
			_ => None,
		};
		if let Some(token) = punctuation {
			tokens.push((token, offset));
			index += 1;
			continue;
		}

		if character.is_ascii_digit() {
			let start = index;
			while index < characters.len() && characters[index].1.is_ascii_digit() {
				index += 1;
			}
			let digits: String = characters[start..index].iter().map(|(_, digit)| *digit).collect();
			let value = digits.parse::<i64>().map_err(|_| ParseError::UnexpectedToken {
				text: digits.clone(),
				offset,
			})?;
			tokens.push((Token::Number(value), offset));
			continue;
		}

		return Err(ParseError::UnexpectedCharacter { character, offset });
	}

	tokens.push((Token::End, text.len()));
	Ok(tokens)
}