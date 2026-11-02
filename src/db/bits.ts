/**
 * Bit definitions for the `is_available` bitmask.
 *
 * Persistent bits recover by **event** (credential change, vendor-declared reset reached);
 * cooldown is not a bit at all — it is `retry_after > now` (audit §2.1), and the day/month quota
 * states are derived from the exhausted-period key (audit §2.5). Old DB files that still carry
 * the retired slots decode tolerantly and are migrated at the next refresh.
 */

export const BIT = {
  /** [LEGACY] Daily quota exhausted — retired: derived from the exhausted-period key. Old files decode; never set by new code. */
  QUOTA_DAY: 1 << 0,
  /** [LEGACY] Monthly quota exhausted — retired: derived from the exhausted-period key. Old files decode; never set by new code. */
  QUOTA_MONTH: 1 << 1,
  /**
   * [LEGACY] Credential missing — retired: derivable at read time from the config×credentials
   * pair. The constant stays only so old DB files decode and are migrated; never set by new code.
   */
  CREDENTIAL_MISSING: 1 << 2,
  /** Credential rejected (provider 401, or the authentication semantics of 403) */
  CREDENTIAL_REJECTED: 1 << 3,
  /** [LEGACY] Network / timeout / 5xx / parse failure — retired: cooldown is derived from retry_after. Old files decode; never set by new code. */
  TRANSIENT: 1 << 4,
  /** [LEGACY] 429 rate limiting of a short window — retired: cooldown is derived from retry_after. Old files decode; never set by new code. */
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

/**
 * Bits that a legacy write path could set with a `retry_after`. New code never touches bits for
 * cooldown (audit §2.1) — the mask survives only because `setBits` keeps its legacy guard and
 * the migration clears the slots.
 */
export const TRANSIENT_BIT_MASK = BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT;

/** Bits that recover by event: credential appearing or changing, vendor-declared reset reached. */
export const PERSISTENT_BIT_MASK = BIT.QUOTA_UNKNOWN | BIT.CREDENTIAL_REJECTED;

/**
 * Legacy slots: old DB files may carry them; migrated unconditionally at refresh. Covers the
 * retired credential-missing/paid slots, the four time-derived states (cooldown ×2, quota day ×
 * month) and nothing else — QUOTA_UNKNOWN and CREDENTIAL_REJECTED remain live bits.
 */
export const LEGACY_BIT_MASK =
  BIT.CREDENTIAL_MISSING |
  BIT.PAID_NOT_ALLOWED |
  BIT.QUOTA_DAY |
  BIT.QUOTA_MONTH |
  BIT.TRANSIENT |
  BIT.RATE_LIMITED_SHORT;

/** Bits that a period boundary **must not** clear */
export const PERIOD_IRRELEVANT_BIT_MASK = BIT.QUOTA_UNKNOWN | BIT.CREDENTIAL_REJECTED;

/**
 * Reason labels presented externally; used for structured rejection and the status tool.
 * `cooldown` is the P0-2 collapsed label of the formerly distinct `transient_failure` /
 * `rate_limited_short` pair — derived from `retry_after`, not decoded from any bit. The two
 * legacy labels survive only in the decode of not-yet-migrated old files.
 */
export type Reason =
  | 'quota_exhausted_day'
  | 'quota_exhausted_month'
  | 'quota_exhausted_unknown'
  | 'credential_missing'
  | 'credential_rejected'
  | 'transient_failure'
  | 'rate_limited_short'
  | 'cooldown'
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
