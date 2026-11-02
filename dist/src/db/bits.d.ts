/**
 * Bit definitions for the `is_available` bitmask.
 *
 * Persistent bits recover by **event** (credential change, vendor-declared reset reached);
 * cooldown is not a bit at all — it is `retry_after > now` (audit §2.1), and the day/month quota
 * states are derived from the exhausted-period key (audit §2.5). Old DB files that still carry
 * the retired slots decode tolerantly and are migrated at the next refresh.
 */
export declare const BIT: {
    /** [LEGACY] Daily quota exhausted — retired: derived from the exhausted-period key. Old files decode; never set by new code. */
    readonly QUOTA_DAY: number;
    /** [LEGACY] Monthly quota exhausted — retired: derived from the exhausted-period key. Old files decode; never set by new code. */
    readonly QUOTA_MONTH: number;
    /**
     * [LEGACY] Credential missing — retired: derivable at read time from the config×credentials
     * pair. The constant stays only so old DB files decode and are migrated; never set by new code.
     */
    readonly CREDENTIAL_MISSING: number;
    /** Credential rejected (provider 401, or the authentication semantics of 403) */
    readonly CREDENTIAL_REJECTED: number;
    /** [LEGACY] Network / timeout / 5xx / parse failure — retired: cooldown is derived from retry_after. Old files decode; never set by new code. */
    readonly TRANSIENT: number;
    /** [LEGACY] 429 rate limiting of a short window — retired: cooldown is derived from retry_after. Old files decode; never set by new code. */
    readonly RATE_LIMITED_SHORT: number;
    /**
     * [LEGACY] The retired paid gate. Constants remain so old DB files decode and are migrated;
     * never set by new code.
     */
    readonly PAID_NOT_ALLOWED: number;
    /**
     * Quota exhausted with **no determinable reset period** (the adapter declares quotaPeriod =
     * 'none'), so it is neither the day nor the month quota bit.
     *
     * Persistent: **never cleared automatically** — not by the passage of time, not by a period
     * boundary — only by an external event (credential swap, config change).
     */
    readonly QUOTA_UNKNOWN: number;
};
export type BitName = keyof typeof BIT;
/** All defined bits, used for mask validation and state decoding. */
export declare const ALL_BITS: readonly number[];
/**
 * Bits that a legacy write path could set with a `retry_after`. New code never touches bits for
 * cooldown (audit §2.1) — the mask survives only because `setBits` keeps its legacy guard and
 * the migration clears the slots.
 */
export declare const TRANSIENT_BIT_MASK: number;
/** Bits that recover by event: credential appearing or changing, vendor-declared reset reached. */
export declare const PERSISTENT_BIT_MASK: number;
/**
 * Legacy slots: old DB files may carry them; migrated unconditionally at refresh. Covers the
 * retired credential-missing/paid slots, the four time-derived states (cooldown ×2, quota day ×
 * month) and nothing else — QUOTA_UNKNOWN and CREDENTIAL_REJECTED remain live bits.
 */
export declare const LEGACY_BIT_MASK: number;
/** Bits that a period boundary **must not** clear */
export declare const PERIOD_IRRELEVANT_BIT_MASK: number;
/**
 * Reason labels presented externally; used for structured rejection and the status tool.
 * `cooldown` is the P0-2 collapsed label of the formerly distinct `transient_failure` /
 * `rate_limited_short` pair — derived from `retry_after`, not decoded from any bit. The two
 * legacy labels survive only in the decode of not-yet-migrated old files.
 */
export type Reason = 'quota_exhausted_day' | 'quota_exhausted_month' | 'quota_exhausted_unknown' | 'credential_missing' | 'credential_rejected' | 'transient_failure' | 'rate_limited_short' | 'cooldown' | 'paid_not_allowed' | 'unknown';
/** Decode a bitmask into reasons. Unknown bits in the mask yield `unknown`. */
export declare function decodeReasons(mask: number): Reason[];
/** Whether this mask means "usable". The sole criterion. */
export declare function isUsable(mask: number): boolean;
/** Validate that a bitmask contains only defined bits (a guard before writing). */
export declare function isKnownMask(mask: number): boolean;
