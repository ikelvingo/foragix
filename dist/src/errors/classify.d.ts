/** Cooldown bounds in milliseconds. The upper bound keeps a permanently broken provider retried once per minute. */
export declare const COOLDOWN_MIN_MS = 1000;
export declare const COOLDOWN_MAX_MS = 60000;
export declare const BACKOFF_BASE_MS = 1000;
export type Classification = 
/** Success; a legitimately empty result also counts as success. */
{
    readonly kind: 'success';
}
/** Quota/balance exhausted. `period === null` means it cannot be determined whether the cycle is daily or monthly.
 *  `resetAt` (optional) carries a vendor-DECLARED reset boundary read out of the refusal itself — lane A. */
 | {
    readonly kind: 'quota';
    readonly period: 'day' | 'month' | null;
    readonly evidence: string;
    readonly resetAt?: number;
}
/** Credential rejected (401, or the authentication semantics of a 403). */
 | {
    readonly kind: 'credential_rejected';
    readonly evidence: string;
}
/** Transient failure (network / timeout / 5xx / parse failure). */
 | {
    readonly kind: 'transient';
    readonly evidence: string;
    readonly cooldownMs?: number;
}
/** Rate limiting that clearly belongs to a short window: cooldown only, never day/month disabling. */
 | {
    readonly kind: 'rate_limited_short';
    readonly evidence: string;
    readonly cooldownMs?: number;
}
/** Defaulted into "our problem": do not set flags, switch to another provider and surface it prominently. */
 | {
    readonly kind: 'our_problem';
    readonly evidence: string;
};
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
/** Parse `Retry-After` (seconds or an HTTP date) into relative milliseconds; null when unparseable. */
export declare function parseRetryAfter(value: string | null, now: number): number | null;
export declare function clampCooldown(ms: number): number;
/** Exponential backoff: the n-th consecutive transient failure (n starts at 1) yields `base * 2^(n-1)`, capped at COOLDOWN_MAX_MS. */
export declare function backoffMs(streak: number, base?: number): number;
/** Best-effort extraction of an error code from the response body. Tolerates non-JSON and truncated JSON. */
export declare function extractErrorCode(body: string | undefined): string | null;
/** Whether the response body expresses the semantics of "quota/balance exhausted". */
export declare function bodySuggestsQuota(body: string | undefined): boolean;
/** Whether the response body expresses the semantics of "credential rejected". */
export declare function bodySuggestsAuth(body: string | undefined): boolean;
/** The cooldown suggestion (in milliseconds) attached to a classification result; null when there is none. */
export declare function cooldownOf(result: Classification, input: ResponseInput, now: number): number | null;
/**
 * Classify an HTTP response; `now` is the current time, used to parse the date form of `Retry-After`.
 * Evidence is redacted once here, at the classification boundary, so no adapter — including
 * third-party ones — can carry a suspected credential into the logs verbatim.
 */
export declare function classifyResponse(input: ResponseInput, now?: number): Classification;
/** Redact the evidence text uniformly for all classification results, non-transient branches included. */
export declare function sanitizeEvidence(result: Classification): Classification;
/**
 * Network-layer failures (connection / DNS / TLS / timeout) are uniformly transient. The
 * exception message is never included: a fetch error may carry the full URL, including a key
 * in the query parameters.
 */
export declare function classifyNetworkError(err: unknown): Classification;
/** Classified as a transient failure when the response body cannot be parsed into the expected structure. */
export declare function classifyParseFailure(detail: string): Classification;
