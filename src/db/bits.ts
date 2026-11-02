/**
 * Bit definitions for the `is_available` bitmask.
 *
 * Persistent bits recover by **event**; transient bits recover by **time** (retry_after expiry).
 * Multiple causes can coexist: clearing one of them must not make the provider usable; only a
 * mask of zero restores it.
 */

export const BIT = {
  /** Daily quota exhausted */
  QUOTA_DAY: 1 << 0,
  /** Monthly quota exhausted */
  QUOTA_MONTH: 1 << 1,
  /**
   * [LEGACY] Credential missing — retired: derivable at read time from the config×credentials
   * pair. The constant stays only so old DB files decode and are migrated; never set by new code.
   */
  CREDENTIAL_MISSING: 1 << 2,
  /** Credential rejected (provider 401, or the authentication semantics of 403) */
  CREDENTIAL_REJECTED: 1 << 3,
  /** Network / timeout / 5xx / parse failure — transient */
  TRANSIENT: 1 << 4,
  /** 429 rate limiting that clearly belongs to a short window — transient */
  RATE_LIMITED_SHORT: 1 << 5,
  /**
   * [LEGACY] The retired paid gate. Constants remain so old DB files decode and are migrated;
   * never set by new code.
   */
  PAID_NOT_ALLOWED: 1 << 6,
  /**
   * Quota exhausted with **no determinable reset period** (the adapter declares quotaPeriod =
   * 'none'), so it is neither the day nor the month quota bit.
   *
   * Persistent: **never cleared automatically** — not by the passage of time, not by a period
   * boundary — only by an external event (credential swap, config change).
   */
  QUOTA_UNKNOWN: 1 << 7,
} as const;

export type BitName = keyof typeof BIT;

/** All defined bits, used for mask validation and state decoding. */
export const ALL_BITS: readonly number[] = Object.values(BIT);

/** Bits that recover by time: a retry_after must be given when setting them. */
export const TRANSIENT_BIT_MASK = BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT;

/** Bits that recover by event: period boundary, credential appearing or changing, config change */
export const PERSISTENT_BIT_MASK =
  BIT.QUOTA_DAY |
  BIT.QUOTA_MONTH |
  BIT.QUOTA_UNKNOWN |
  BIT.CREDENTIAL_REJECTED;

/** Legacy slots (old DB files may carry them; migrated unconditionally at refresh). */
export const LEGACY_BIT_MASK = BIT.CREDENTIAL_MISSING | BIT.PAID_NOT_ALLOWED;

/** Bits that a period boundary **must not** clear */
export const PERIOD_IRRELEVANT_BIT_MASK = BIT.QUOTA_UNKNOWN | BIT.CREDENTIAL_REJECTED;

/** Reason labels presented externally by the state machine; used for structured rejection and the status tool, not involved in decisions. */
export type Reason =
  | 'quota_exhausted_day'
  | 'quota_exhausted_month'
  | 'quota_exhausted_unknown'
  | 'credential_missing'
  | 'credential_rejected'
  | 'transient_failure'
  | 'rate_limited_short'
  | 'paid_not_allowed'
  | 'unknown';

const REASON_BY_BIT: ReadonlyArray<readonly [number, Reason]> = [
  [BIT.QUOTA_DAY, 'quota_exhausted_day'],
  [BIT.QUOTA_MONTH, 'quota_exhausted_month'],
  [BIT.QUOTA_UNKNOWN, 'quota_exhausted_unknown'],
  [BIT.CREDENTIAL_MISSING, 'credential_missing'],
  [BIT.CREDENTIAL_REJECTED, 'credential_rejected'],
  [BIT.TRANSIENT, 'transient_failure'],
  [BIT.RATE_LIMITED_SHORT, 'rate_limited_short'],
  [BIT.PAID_NOT_ALLOWED, 'paid_not_allowed'],
];

/** Decode a bitmask into reasons. Unknown bits in the mask yield `unknown`. */
export function decodeReasons(mask: number): Reason[] {
  const out: Reason[] = [];
  let known = 0;
  for (const [bit, reason] of REASON_BY_BIT) {
    if ((mask & bit) !== 0) {
      out.push(reason);
      known |= bit;
    }
  }
  if ((mask & ~known) !== 0) out.push('unknown');
  return out;
}

/** Whether this mask means "usable". The sole criterion. */
export function isUsable(mask: number): boolean {
  return mask === 0;
}

/** Validate that a bitmask contains only defined bits (a guard before writing). */
export function isKnownMask(mask: number): boolean {
  if (!Number.isInteger(mask) || mask < 0) return false;
  const defined = ALL_BITS.reduce((acc, b) => acc | b, 0);
  return (mask & ~defined) === 0;
}
