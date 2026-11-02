/**
 * Redaction. Credential values must not appear in SQLite, logs, or error messages, and external
 * text — e.g. an exception message carrying a URL with a key in the query parameters — must
 * never pass through verbatim.
 *
 * This is best-effort, not a security guarantee: callers must not rely on it as the only defence.
 */
/**
 * Redact a piece of text that may come from outside. **Best-effort only, not a security
 * guarantee**: the patterns cover known credential shapes only, so callers must not treat the
 * result as safe to log; the safe alternative is {@link describeError}.
 */
export declare function redact(text: string, maxLength?: number): string;
/**
 * Normalize an arbitrary exception into a short description that is safe to log. The exception
 * message is never included: external text never enters diagnostics or logs. `name` is restricted
 * to the standard error-name allowlist and `code` to the closed set of known error codes.
 */
export declare function describeError(err: unknown): string;
