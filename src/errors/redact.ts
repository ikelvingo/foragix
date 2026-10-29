/**
 * Redaction. Credential values must not appear in SQLite, logs, or error messages, and external
 * text — e.g. an exception message carrying a URL with a key in the query parameters — must
 * never pass through verbatim.
 *
 * This is best-effort, not a security guarantee: callers must not rely on it as the only defence.
 */

/** Common credential shapes; false positives are acceptable, misses are not. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|fc|tvly|as_sk|xoxb|xoxp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/gi,
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // An assignment of the form `field name: value`. `authorization` must be included — a bare
  // `authorization: <value>` without `Bearer` is the class most easily missed.
  /\b(authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|credential|passwd|pwd)\b\s*[:=]\s*["']?[^\s"',;}\]]{4,}/gi,
  /\b[0-9a-f]{32,}\b/gi,
];

const REDACTED = '[redacted]';

/** Strip the query and fragment of a URL — that is where a key most often lives. */
function stripUrlSecrets(text: string): string {
  return text.replace(/\b(https?:\/\/[^\s"'<>]+)/gi, (match) => {
    try {
      const url = new URL(match);
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // Not a valid URL: conservatively cut off everything after `?`
      const cut = match.indexOf('?');
      return cut === -1 ? match : `${match.slice(0, cut)}?[redacted]`;
    }
  });
}

/**
 * Redact a piece of text that may come from outside. **Best-effort only, not a security
 * guarantee**: the patterns cover known credential shapes only, so callers must not treat the
 * result as safe to log; the safe alternative is {@link describeError}.
 */
export function redact(text: string, maxLength = 200): string {
  let out = stripUrlSecrets(text);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
  return out;
}

/** Allowlist of standard error names; anything else is normalized to `Error` — exception objects can be constructed arbitrarily. */
const KNOWN_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'DOMException',
  'FetchError',
  'NetworkError',
  'HttpError',
  'RequestError',
  'SystemError',
  'AssertionError',
  'YAMLParseError',
]);

/** The **closed set** of known error codes: anything not listed is discarded, so the boundary of what can appear in output is statable. */
const KNOWN_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EPROTO', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE',
  'ENOSPC', 'EBUSY', 'ENOTEMPTY', 'EROFS', 'ELOOP', 'ENAMETOOLONG',
  'ABORT_ERR', 'ERR_CANCELED',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_STATE', 'ERR_OUT_OF_RANGE',
  'ERR_ASSERTION', 'ERR_INVALID_URL', 'ERR_MISSING_ARGS', 'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_TEST_FAILURE', 'ERR_SQLITE_ERROR',
  'SQLITE_BUSY', 'SQLITE_ERROR', 'SQLITE_CONSTRAINT', 'SQLITE_MISUSE', 'SQLITE_READONLY',
  'SQLITE_CANTOPEN', 'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_IOERR',
  'SQLITE_LOCKED', 'SQLITE_PERM',
]);

/**
 * Normalize an arbitrary exception into a short description that is safe to log. The exception
 * message is never included: external text never enters diagnostics or logs. `name` is restricted
 * to the standard error-name allowlist and `code` to the closed set of known error codes.
 */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return 'unknown error (string thrown)';

  const rawName = (err as { name?: unknown }).name;
  const rawCode = (err as { code?: unknown }).code;

  const name = typeof rawName === 'string' && KNOWN_ERROR_NAMES.has(rawName) ? rawName : 'Error';
  const code = typeof rawCode === 'string' && KNOWN_ERROR_CODES.has(rawCode) ? rawCode : null;
  return code === null ? name : `${name}: ${code}`;
}
