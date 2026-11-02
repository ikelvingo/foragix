/**
 * State reset and gate synchronization.
 *
 * Only a cause with a determinable recovery condition may set a bit: persistent bits (quota,
 * credentials, paid gate) recover on an event; transient bits (network, short-window limiting)
 * recover when `retry_after` expires. All resets are lazy — decided before each call, no timer.
 */
import type { SqliteAdapter } from '../db/sqlite.js';
import { BIT, decodeReasons, type Reason } from '../db/bits.js';
import { DEFAULT_TIMEZONE, periodKeys } from '../db/period.js';

export interface ResetContext {
  /** Current time, unix ms. */
  now: number;
  /** Whether all required credentials for this provider are present. */
  credentialsPresent: boolean;
  /** Credential fingerprint; null means it cannot be computed (credentials incomplete). */
  credentialFingerprint: string | null;
  /** Effective allow_paid (the value after provider-level override). */
  allowPaid: boolean;
}

export interface ResetOutcome {
  /** The period resets actually performed this time. */
  periodResets: Array<'day' | 'month'>;
  /** The provider's disable reasons before the reset, for use in status output. */
  reasonsBefore: Reason[];
  /** Whether it is usable after the reset. */
  usableAfter: boolean;
}

/**
 * One lazy reset check; must run before availability is read.
 *
 * Clearing rules: day/month boundary → QUOTA_DAY / QUOTA_MONTH (day and month are independent and
 * the first init never counts as a boundary); `retry_after` reached → TRANSIENT | RATE_LIMITED_SHORT;
 * credentials present → CREDENTIAL_MISSING; legacy PAID bits are cleared at refresh; credential fingerprint
 * changed → CREDENTIAL_REJECTED (presence alone is not enough, and a change only permits a retry).
 */
export function applyResets(adapter: SqliteAdapter, providerId: string, ctx: ResetContext): ResetOutcome {
  adapter.ensureProvider(providerId);
  const row = adapter.getProvider(providerId);
  if (row === null) throw new Error(`provider_state row missing: ${providerId}`);

  const reasonsBefore = decodeReasons(row.is_available);
  const timezone = row.reset_timezone ?? DEFAULT_TIMEZONE;
  const keys = periodKeys(timezone, ctx.now);
  const periodResets: Array<'day' | 'month'> = [];

  // The quota bits follow the reset period the provider declares, so a provider with no determinable
  // period is not silently recovered at a month boundary. An unseeded quota_period is treated as 'both'.
  const quotaPeriod = row.quota_period ?? 'both';
  const dayResets = quotaPeriod === 'day' || quotaPeriod === 'both';
  const monthResets = quotaPeriod === 'month' || quotaPeriod === 'both';

  // 1) Day period boundary: zero the counters and clear "daily quota exhausted"
  if (row.day_key !== keys.day) {
    const isFirstInit = row.day_key === null;
    adapter.resetPeriod(providerId, 'day', keys.day);
    if (!isFirstInit && dayResets) {
      adapter.clearBits(providerId, BIT.QUOTA_DAY);
      periodResets.push('day');
      adapter.log({ providerId, at: ctx.now, kind: 'period_reset', detail: `day ${row.day_key} → ${keys.day}` });
    }
  }

  // 2) Month period boundary. Independent of the day period — one expiring must not zero the other's counters.
  if (row.month_key !== keys.month) {
    const isFirstInit = row.month_key === null;
    adapter.resetPeriod(providerId, 'month', keys.month);
    if (!isFirstInit && monthResets) {
      adapter.clearBits(providerId, BIT.QUOTA_MONTH);
      periodResets.push('month');
      adapter.log({ providerId, at: ctx.now, kind: 'period_reset', detail: `month ${row.month_key} → ${keys.month}` });
    }
  }

  // 3) Transient bit cooldown expired
  if (row.retry_after !== null && row.retry_after <= ctx.now) {
    const had = row.is_available & (BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT);
    adapter.clearBits(providerId, BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT);
    adapter.setRetryAfter(providerId, null);
    if (had !== 0) {
      adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: `cooldown expired (${had})` });
    }
  }

  // 4) Credentials present → clear "credentials missing"
  if (ctx.credentialsPresent && (row.is_available & BIT.CREDENTIAL_MISSING) !== 0) {
    adapter.clearBits(providerId, BIT.CREDENTIAL_MISSING);
    adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: 'credentials present' });
  }

  // 5) Credential fingerprint changed → clear "credential rejected". Presence alone does not
  //    clear it; a change only permits a retry.
  if (ctx.credentialFingerprint !== null) {
    if (row.credential_fingerprint === null) {
      // First record, not counted as a change
      adapter.setCredentialFingerprint(providerId, ctx.credentialFingerprint);
    } else if (row.credential_fingerprint !== ctx.credentialFingerprint) {
      adapter.setCredentialFingerprint(providerId, ctx.credentialFingerprint);
      if ((row.is_available & BIT.CREDENTIAL_REJECTED) !== 0) {
        adapter.clearBits(providerId, BIT.CREDENTIAL_REJECTED);
        adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: 'credential fingerprint changed' });
      }
    }
  }

  // 6) The paid-gate concept is retired: the old bit from state written by previous versions
  //    is removed unconditionally at refresh time (there is no gate left to re-set it).
  if ((row.is_available & BIT.PAID_NOT_ALLOWED) !== 0) {
    adapter.clearBits(providerId, BIT.PAID_NOT_ALLOWED);
    adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: 'paid gate retired' });
  }

  const after = adapter.getProvider(providerId);
  return {
    periodResets,
    reasonsBefore,
    usableAfter: after !== null && after.is_available === 0,
  };
}

export interface CredentialGateContext {
  now: number;
  /** Whether all required credentials for this provider are present. */
  credentialsPresent: boolean;
}

/**
 * Set the credentials-missing bit; `applyResets` clears it once credentials appear.
 * Must run before routing, otherwise a credential-less provider would be called with an empty key.
 */
export function syncCredentialGate(adapter: SqliteAdapter, providerId: string, ctx: CredentialGateContext): void {
  adapter.ensureProvider(providerId);
  if (ctx.credentialsPresent) return; // recovery is handled by applyResets

  const row = adapter.getProvider(providerId);
  if (row === null) return;
  if ((row.is_available & BIT.CREDENTIAL_MISSING) !== 0) return;

  adapter.setBits(providerId, BIT.CREDENTIAL_MISSING);
  adapter.log({ providerId, at: ctx.now, kind: 'bit_set', detail: 'credential_missing' });
}
