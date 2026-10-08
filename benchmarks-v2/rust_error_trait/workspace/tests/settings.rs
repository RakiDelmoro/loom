use config_error::{parse_port, parse_settings, ConfigError, ConfigErrorKind, Settings};

#[test]
fn reads_a_port() {
	assert_eq!(parse_port("8080"), Ok(8080));
	assert_eq!(parse_port("0"), Ok(0));
	assert_eq!(parse_port("65535"), Ok(65535));
}

#[test]
fn rejects_a_port_that_is_not_a_number() {
	assert_eq!(
		parse_port("http"),
		Err(ConfigError::new(ConfigErrorKind::NotANumber, "port"))
	);
}

#[test]
fn rejects_a_port_that_does_not_fit_in_sixteen_bits() {
	assert_eq!(
		parse_port("65536"),
		Err(ConfigError::new(ConfigErrorKind::OutOfRange, "port"))
	);
}

#[test]
fn reads_a_document() {
	assert_eq!(
		parse_settings("host=local\nport=8080\n"),
		Ok(Settings {
			host: "local".to_string(),
			port: 8080,
		})
	);
}

#[test]
fn ignores_a_key_it_does_not_know() {
	assert_eq!(
		parse_settings("host=local\nport=80\ncolour=blue\n"),
		Ok(Settings {
			host: "local".to_string(),
			port: 80,
		})
	);
}

#[test]
fn names_the_key_that_is_missing() {
	assert_eq!(
		parse_settings("port=80\n"),
		Err(ConfigError::new(ConfigErrorKind::MissingKey, "host"))
	);
	assert_eq!(
		parse_settings("host=local\n"),
		Err(ConfigError::new(ConfigErrorKind::MissingKey, "port"))
	);
}

#[test]
fn reports_a_bad_port_against_its_key() {
	assert_eq!(
		parse_settings("host=local\nport=eight\n"),
		Err(ConfigError::new(ConfigErrorKind::NotANumber, "port"))
	);
}

#[test]
fn an_error_says_what_is_wrong() {
	assert_eq!(
		ConfigError::new(ConfigErrorKind::MissingKey, "host").to_string(),
		"missing key \"host\""
	);
	assert_eq!(
		ConfigError::new(ConfigErrorKind::NotANumber, "port").to_string(),
		"port is not a number"
	);
	assert_eq!(
		ConfigError::new(ConfigErrorKind::OutOfRange, "port").to_string(),
		"port is out of range"
	);
}

#[test]
fn an_error_is_a_standard_error() {
	use std::error::Error;

	let error = ConfigError::new(ConfigErrorKind::MissingKey, "host");
	let boxed: Box<dyn Error> = Box::new(error);
	assert_eq!(boxed.to_string(), "missing key \"host\"");
	assert!(boxed.source().is_none());
}

#[test]
fn the_question_mark_operator_carries_it() {
	fn read(document: &str) -> Result<u16, Box<dyn std::error::Error>> {
		Ok(parse_settings(document)?.port)
	}

	assert_eq!(read("host=local\nport=8080\n").unwrap(), 8080);
	assert_eq!(
		read("host=local\n").unwrap_err().to_string(),
		"missing key \"port\""
	);
}