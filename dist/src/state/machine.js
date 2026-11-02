import { BIT, LEGACY_BIT_MASK, decodeReasons } from '../db/bits.js';
import { DEFAULT_TIMEZONE, periodKeys } from '../db/period.js';
/**
 * One lazy reset check; must run before availability is read.
 *
 * Clearing rules: day/month boundary → counters zeroed and keys advanced (quota STATES are
 * derived from the exhausted-period key); `retry_after` reached → cooldown cleared;
 * legacy slots (credential-missing/paid, the four retired time-derived states) are migrated
 * unconditionally; credential fingerprint changed → CREDENTIAL_REJECTED cleared; vendor-declared
 * reset reached → QUOTA_UNKNOWN cleared (lane A).
 */
export function applyResets(adapter, providerId, ctx) {
    adapter.ensureProvider(providerId);
    const row = adapter.getProvider(providerId);
    if (row === null)
        throw new Error(`provider_state row missing: ${providerId}`);
    const reasonsBefore = decodeReasons(row.is_available);
    const timezone = row.reset_timezone ?? DEFAULT_TIMEZONE;
    const keys = periodKeys(timezone, ctx.now);
    const periodResets = [];
    // The quota bits follow the reset period the provider declares, so a provider with no determinable
    // period is not silently recovered at a month boundary. An unseeded quota_period is treated as 'both'.
    const quotaPeriod = row.quota_period ?? 'both';
    const dayResets = quotaPeriod === 'day' || quotaPeriod === 'both';
    const monthResets = quotaPeriod === 'month' || quotaPeriod === 'both';
    // 1) Day period boundary: zero the counters and advance the key. The quota STATE is derived
    //    from the exhausted-period key (audit §2.5) — no bit is cleared here.
    if (row.day_key !== keys.day) {
        adapter.resetPeriod(providerId, 'day', keys.day);
        if (row.day_key !== null && dayResets) {
            periodResets.push('day');
            adapter.log({ providerId, at: ctx.now, kind: 'period_reset', detail: `day ${row.day_key} → ${keys.day}` });
        }
    }
    // 2) Month period boundary. Independent of the day period — one expiring must not zero the other's counters.
    if (row.month_key !== keys.month) {
        adapter.resetPeriod(providerId, 'month', keys.month);
        if (row.month_key !== null && monthResets) {
            periodResets.push('month');
            adapter.log({ providerId, at: ctx.now, kind: 'period_reset', detail: `month ${row.month_key} → ${keys.month}` });
        }
    }
    // 3) Cooldown expired: retry_after is the single persisted cooldown truth (audit §2.1) —
    //    nulling it is the entire recovery; legacy cooldown bits are swept by gate 4.
    if (row.retry_after !== null && row.retry_after <= ctx.now) {
        adapter.setRetryAfter(providerId, null);
        adapter.log({ providerId, at: ctx.now, kind: 'cooldown_clear', detail: `cooldown expired (until ${row.retry_after})` });
    }
    // 4) Legacy slots (old files) are migrated unconditionally: the credential-missing/paid slots
    //    are retired, and the cooldown/quota bits are derivable from retry_after / the exhausted
    //    period key. `clearBits` never nulls retry_after, so a still-running cooldown survives the
    //    sweep; no gate re-sets any of these slots.
    const legacy = row.is_available & LEGACY_BIT_MASK;
    if (legacy !== 0) {
        adapter.clearBits(providerId, LEGACY_BIT_MASK);
        adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: `legacy state cleaned (${legacy})` });
    }
    // 5) Credential fingerprint changed → clear "credential rejected". Presence alone does not
    //    clear it; a change only permits a retry.
    if (ctx.credentialFingerprint !== null) {
        if (row.credential_fingerprint === null) {
            // First record, not counted as a change
            adapter.setCredentialFingerprint(providerId, ctx.credentialFingerprint);
        }
        else if (row.credential_fingerprint !== ctx.credentialFingerprint) {
            adapter.setCredentialFingerprint(providerId, ctx.credentialFingerprint);
            if ((row.is_available & BIT.CREDENTIAL_REJECTED) !== 0) {
                adapter.clearBits(providerId, BIT.CREDENTIAL_REJECTED);
                adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: 'credential fingerprint changed' });
            }
        }
    }
    // 5.5) Provider-declared reset (lane A): QUOTA_UNKNOWN with a vendor-stated boundary clears
    //      when that boundary is passed — the vendor is the authority on when its window rolls.
    if ((row.is_available & BIT.QUOTA_UNKNOWN) !== 0) {
        const vendorReset = adapter.readVendorReset(providerId);
        if (vendorReset !== null && vendorReset <= ctx.now) {
            adapter.clearBits(providerId, BIT.QUOTA_UNKNOWN);
            adapter.writeVendorReset(providerId, null);
            adapter.log({ providerId, at: ctx.now, kind: 'bit_clear', detail: `vendor-declared reset (${vendorReset}) reached` });
        }
    }
    const after = adapter.getProvider(providerId);
    if (after === null)
        throw new Error(`provider_state row missing after resets: ${providerId}`);
    return {
        periodResets,
        reasonsBefore,
        usableAfter: after.is_available === 0,
        rowAfter: after,
    };
}
//# sourceMappingURL=machine.js.map