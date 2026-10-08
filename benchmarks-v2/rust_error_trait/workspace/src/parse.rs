use crate::error::{ConfigError, ConfigErrorKind};

/// The settings a document describes.
#[derive(Debug, PartialEq, Eq)]
pub struct Settings {
	pub host: String,
	pub port: u16,
}

/// Reads a port from a decimal string.
pub fn parse_port(value: &str) -> Result<u16, ConfigError> {
	let _ = value;
	Err(ConfigError::new(ConfigErrorKind::NotANumber, "port"))
}

/// Reads a `key=value` document, one pair per line.
pub fn parse_settings(document: &str) -> Result<Settings, ConfigError> {
	let _ = document;
	Err(ConfigError::new(ConfigErrorKind::MissingKey, "host"))
}