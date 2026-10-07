/**
 * Secret redaction.
 *
 * A run's log is a document about untrusted content: a file in the workspace can
 * contain anything, including a credential it managed to read, and a tool result
 * carries it straight into the transcript. Structural hygiene — keeping keys out
 * of the Blueprint and the deployment file — is necessary but not sufficient, so
 * every line written to a run's record passes through here first.
 */

export type Redact = (text: string) => string

export const REDACTION_PLACEHOLDER = '[redacted]'

/**
 * Below this, a "secret" is indistinguishable from ordinary text and redacting it
 * would corrupt the log. Real keys are far longer.
 */
const MIN_SECRET_LENGTH = 8

export function createRedactor(secrets: readonly string[]): Redact {
	const usable = new Set(secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH))
	return (text) => {
		let redacted = text
		for (const secret of usable) redacted = redacted.split(secret).join(REDACTION_PLACEHOLDER)
		return redacted
	}
}

/** The identity redactor, for runs with no credentials in play. */
export function noRedaction(text: string): string {
	return text
}
