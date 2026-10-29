/**
 * HTTP response classification. A provider's verified `hints` mapping always wins over the generic rules.
 * `Retry-After` / `RateLimit-*` headers alone do not prove a short window; an unrecognisable 403 is blamed on neither side.
 */
import { describeError, redact } from './redact.js';

/** Cooldown bounds in milliseconds. The upper bound keeps a permanently broken provider retried once per minute. */
export const COOLDOWN_MIN_MS = 1_000;
export const COOLDOWN_MAX_MS = 60_000;
export const BACKOFF_BASE_MS = 1_000;

export type Classification =
  /** Success; a legitimately empty result also counts as success. */
  | { readonly kind: 'success' }
  /** Quota/balance exhausted. `period === null` means it cannot be determined whether the cycle is daily or monthly. */
  | { readonly kind: 'quota'; readonly period: 'day' | 'month' | null; readonly evidence: string }
  /** Credential rejected (401, or the authentication semantics of a 403). */
  | { readonly kind: 'credential_rejected'; readonly evidence: string }
  /** Transient failure (network / timeout / 5xx / parse failure). */
  | { readonly kind: 'transient'; readonly evidence: string; readonly cooldownMs?: number }
  /** Rate limiting that clearly belongs to a short window: cooldown only, never day/month disabling. */
  | { readonly kind: 'rate_limited_short'; readonly evidence: string; readonly cooldownMs?: number }
  /** Defaulted into "our problem": do not set flags, switch to another provider and surface it prominently. */
  | { readonly kind: 'our_problem'; readonly evidence: string };

export interface ProviderErrorHints {
  /** Verified status-code mapping, takes precedence over generic heuristics. */
  readonly statusMap?: Readonly<Record<number, Classification>>;
  /** Verified quota-exhaustion error codes (the code field of the response body JSON). */
  readonly quotaErrorCodes?: readonly string[];
  /** Verified credential-rejected error codes. */
  readonly authErrorCodes?: readonly string[];
}

export interface ResponseInput {
  readonly status: number;
  /** Response headers; header names are case-insensitive. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Response body text, used for semantic classification. May be truncated. */
  readonly body?: string;
  readonly hints?: ProviderErrorHints;
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | null {
  if (headers === undefined) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** Parse `Retry-After` (seconds or an HTTP date) into relative milliseconds; null when unparseable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds >= 0 ? seconds * 1000 : null;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function clampCooldown(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return COOLDOWN_MIN_MS;
  return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.trunc(ms)));
}

/** Exponential backoff: the n-th consecutive transient failure (n starts at 1) yields `base * 2^(n-1)`, capped at COOLDOWN_MAX_MS. */
export function backoffMs(streak: number, base = BACKOFF_BASE_MS): number {
  if (!Number.isFinite(streak) || streak < 1) return clampCooldown(base);
  if (streak > 20) return COOLDOWN_MAX_MS;
  return clampCooldown(base * 2 ** (streak - 1));
}

/** Best-effort extraction of an error code from the response body. Tolerates non-JSON and truncated JSON. */
export function extractErrorCode(body: string | undefined): string | null {
  if (body === undefined || body === '') return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['code', 'error_code', 'errorCode', 'status_code']) {
        const value = record[key];
        if (typeof value === 'string' || typeof value === 'number') return String(value);
      }
      // One level of nesting: { error: { code } }
      const nested = record['error'];
      if (typeof nested === 'object' && nested !== null) {
        const inner = (nested as Record<string, unknown>)['code'];
        if (typeof inner === 'string' || typeof inner === 'number') return String(inner);
      }
    }
  } catch {
    // Not a JSON body: fall back to regex
  }
  const match = /"?(?:code|error_code)"?\s*[:=]\s*"?([A-Za-z0-9_.-]+)"?/.exec(body);
  return match?.[1] ?? null;
}

const QUOTA_BODY_HINTS = [
  /\bquota\b/i,
  /\bcredit(s)?\b/i,
  /\bbilling\b/i,
  /\binsufficient\b/i,
  /\bbalance\b/i,
  /\bexceed(ed)?\b/i,
  /\bmonthly\b/i,
  /\bsubscription\b/i,
  /\bplan\s+limit\b/i,
  /\bupgrade\b/i,
  // The CJK patterns match Chinese vendor error bodies; they are executable logic — do not
  // translate or remove them.
  /额度/,
  /余额/,
  /配额/,
];

const AUTH_BODY_HINTS = [
  /\binvalid\s+(api\s*)?key\b/i,
  /\bunauthorized\b/i,
  /\bauthentication\b/i,
  /\bapi\s*key\b/i,
  /\baccess\s*token\b/i,
  /\bcredential/i,
  // Chinese vendor error bodies, as above.
  /密钥/,
  /凭证/,
];

function bodyMatches(body: string | undefined, patterns: readonly RegExp[]): boolean {
  if (body === undefined || body === '') return false;
  return patterns.some((p) => p.test(body));
}

/** Whether the response body expresses the semantics of "quota/balance exhausted". */
export function bodySuggestsQuota(body: string | undefined): boolean {
  return bodyMatches(body, QUOTA_BODY_HINTS);
}

/** Whether the response body expresses the semantics of "credential rejected". */
export function bodySuggestsAuth(body: string | undefined): boolean {
  return bodyMatches(body, AUTH_BODY_HINTS);
}

/** The cooldown suggestion (in milliseconds) attached to a classification result; null when there is none. */
export function cooldownOf(result: Classification, input: ResponseInput, now: number): number | null {
  if (result.kind !== 'transient' && result.kind !== 'rate_limited_short') return null;
  if (result.cooldownMs !== undefined) return result.cooldownMs;
  const retry_after = parseRetryAfter(headerValue(input.headers, 'retry-after'), now);
  return retry_after === null ? null : clampCooldown(retry_after);
}

/**
 * Classify an HTTP response; `now` is the current time, used to parse the date form of `Retry-After`.
 * Evidence is redacted once here, at the classification boundary, so no adapter — including
 * third-party ones — can carry a suspected credential into the logs verbatim.
 */
export function classifyResponse(input: ResponseInput, now: number = Date.now()): Classification {
  return sanitizeEvidence(classifyResponseInner(input, now));
}

/** Redact the evidence text uniformly for all classification results, non-transient branches included. */
export function sanitizeEvidence(result: Classification): Classification {
  if (result.kind === 'success') return result;
  return { ...result, evidence: redact(result.evidence, 200) };
}

function classifyResponseInner(input: ResponseInput, now: number = Date.now()): Classification {
  const { status, body, hints } = input;

  // Decision order: verified status map → verified error codes → success → 402 → 401 → 403 →
  // 429 → transient (408/529/5xx) → default.
  const verified = hints?.statusMap?.[status];
  if (verified !== undefined) return verified;

  const code = extractErrorCode(body);
  if (code !== null) {
    if (hints?.quotaErrorCodes?.includes(code) === true) {
      return { kind: 'quota', period: null, evidence: `verified quota error code ${code}` };
    }
    if (hints?.authErrorCodes?.includes(code) === true) {
      return { kind: 'credential_rejected', evidence: `verified auth error code ${code}` };
    }
  }

  if (status >= 200 && status < 300) return { kind: 'success' };

  // Quota/balance exhausted.
  if (status === 402) {
    return { kind: 'quota', period: null, evidence: 'HTTP 402 Payment Required' };
  }

  // Credential rejected.
  if (status === 401) {
    return { kind: 'credential_rejected', evidence: 'HTTP 401' };
  }

  // 403: the auth and quota semantics overlap, so the response body distinguishes them.
  if (status === 403) {
    if (bodySuggestsAuth(body)) {
      return { kind: 'credential_rejected', evidence: 'HTTP 403 with credential semantics' };
    }
    if (bodySuggestsQuota(body)) {
      return { kind: 'quota', period: null, evidence: 'HTTP 403 with quota semantics' };
    }
    return { kind: 'our_problem', evidence: 'HTTP 403 without recognizable semantics' };
  }

  // 429: split the short window from quota exhaustion.
  if (status === 429) {
    const retry_afterMs = parseRetryAfter(headerValue(input.headers, 'retry-after'), now);
    const hasRateLimitHeader =
      headerValue(input.headers, 'ratelimit-limit') !== null ||
      headerValue(input.headers, 'x-ratelimit-limit') !== null;

    // Quota semantics in the body win over any header signal.
    if (bodySuggestsQuota(body)) {
      return { kind: 'quota', period: null, evidence: 'HTTP 429 with quota semantics' };
    }
    // Short-window signals: Retry-After or rate-limit headers, evaluated after the quota
    // semantics. Any parseable Retry-After is carried into the result, clamped to [1s, 60s].
    if (retry_afterMs !== null) {
      return {
        kind: 'rate_limited_short',
        evidence: 'HTTP 429 with Retry-After',
        cooldownMs: clampCooldown(retry_afterMs),
      };
    }
    if (hasRateLimitHeader) {
      return { kind: 'rate_limited_short', evidence: 'HTTP 429 with rate-limit headers' };
    }
    // No usable signal: default to the short window. Tightening this requires a verified
    // per-provider mapping in `hints`.
    return { kind: 'rate_limited_short', evidence: 'HTTP 429 defaulted to short window (unverified)' };
  }

  // Transient failure; carries the Retry-After along when the provider supplies one.
  if (status === 408 || status === 529 || (status >= 500 && status <= 599)) {
    const retry_afterMs = parseRetryAfter(headerValue(input.headers, 'retry-after'), now);
    return {
      kind: 'transient',
      evidence: `HTTP ${status}`,
      ...(retry_afterMs === null ? {} : { cooldownMs: clampCooldown(retry_afterMs) }),
    };
  }

  // "Our problem": set no flags. Real semantics of 400 / 404 / 413 / 422 must be verified per
  // provider into `hints.statusMap`.
  return { kind: 'our_problem', evidence: `HTTP ${status} (unverified, defaulted)` };
}

/**
 * Network-layer failures (connection / DNS / TLS / timeout) are uniformly transient. The
 * exception message is never included: a fetch error may carry the full URL, including a key
 * in the query parameters.
 */
export function classifyNetworkError(err: unknown): Classification {
  return { kind: 'transient', evidence: `network: ${describeError(err)}` };
}

/** Classified as a transient failure when the response body cannot be parsed into the expected structure. */
export function classifyParseFailure(detail: string): Classification {
  return { kind: 'transient', evidence: `parse failure: ${redact(detail, 120)}` };
}
