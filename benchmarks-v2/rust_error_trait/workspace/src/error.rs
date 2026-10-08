/// Why a settings document could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum ConfigErrorKind {
	/// A key the document has to carry is absent.
	MissingKey,
	/// A value is not a number.
	NotANumber,
	/// A value is a number, but not one this setting accepts.
	OutOfRange,
}

/// A settings document that could not be read.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError {
	pub kind: ConfigErrorKind,
	/// The key the error is about.
	pub key: String,
}

impl ConfigError {
	pub fn new(kind: ConfigErrorKind, key: &str) -> Self {
		Self {
			kind,
			key: key.to_string(),
		}
	}
}