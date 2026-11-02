/**
 * State reset and gate synchronization.
 *
 * Only a cause with a determinable recovery condition may persist a refusal state: the live bits
 * (quota-unknown, credential-rejected) recover on an event; cooldown is `retry_after` alone and
 * expires when the timestamp passes (audit §2.1). All resets are lazy — decided before each call,
 * no timer.
 */
import type { SqliteAdapter, ProviderRow } from '../db/sqlite.js';
import { type Reason } from '../db/bits.js';
export interface ResetContext {
    /** Current time, unix ms. */
    now: number;
    /** Whether all required credentials for this provider are present. */
    credentialsPresent: boolean;
    /** Credential fingerprint; null means it cannot be computed (credentials incomplete). */
    credentialFingerprint: string | null;
}
export interface ResetOutcome {
    /** The period resets actually performed this time. */
    periodResets: Array<'day' | 'month'>;
    /** The provider's disable reasons before the reset, for use in status output. */
    reasonsBefore: Reason[];
    /** Whether it is usable after the reset. */
    usableAfter: boolean;
    /** The post-gate row snapshot: one read, reused by the single-pass routing caller.
     *  Null only on the early-exit path (invalid resetTimezone) where the caller re-reads. */
    rowAfter: ProviderRow | null;
}
/**
 * One lazy reset check; must run before availability is read.
 *
 * Clearing rules: day/month boundary → counters zeroed and keys advanced (quota STATES are
 * derived from the exhausted-period key); `retry_after` reached → cooldown cleared;
 * legacy slots (credential-missing/paid, the four retired time-derived states) are migrated
 * unconditionally; credential fingerprint changed → CREDENTIAL_REJECTED cleared; vendor-declared
 * reset reached → QUOTA_UNKNOWN cleared (lane A).
 */
export declare function applyResets(adapter: SqliteAdapter, providerId: string, ctx: ResetContext): ResetOutcome;
