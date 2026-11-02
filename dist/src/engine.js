import { BIT, decodeReasons } from './db/bits.js';
import { dayKey, isValidTimezone, monthKey, DEFAULT_TIMEZONE } from './db/period.js';
import { applyResets } from './state/machine.js';
import { planSelection } from './routing/select.js';
import { backoffMs, clampCooldown } from './errors/classify.js';
import { describeError, redact } from './errors/redact.js';
export class Engine {
    deps;
    /** Providers judged unusable during the load phase (invalid timezone, initialization failure, etc.). */
    disabled = new Map();
    constructor(deps) {
        this.deps = { ...deps, now: deps.now ?? Date.now };
    }
    /**
     * Load-phase initialization: state rows, enable flag, static value seeding, gate sync, period key initialization.
     *
     * **The first call performs no initialization at all** — it all happens here.
     * A single provider failing to initialize does not affect the other providers: it is recorded in disabled and exposed in the state report.
     */
    bootstrap() {
        for (const provider of this.deps.config.providers) {
            const adapter = this.deps.adapters.get(provider.id);
            if (adapter === undefined)
                continue; // config validation already guarantees this cannot happen
            try {
                this.deps.db.transaction(() => {
                    this.deps.db.ensureProvider(provider.id);
                    this.deps.db.setIsEnable(provider.id, provider.enabled);
                    this.reseedIfStale(provider, adapter);
                    this.applyResetsFor(provider, adapter);
                });
            }
            catch (err) {
                // Load-phase failure: do not throw, isolate this provider. The remaining providers must still be usable.
                this.disabled.set(provider.id, `initialization failed: ${describeError(err)}`);
                this.deps.onDiagnostic?.('bootstrap_failed', { providerId: provider.id, error: describeError(err) });
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Static value seeding
    // ---------------------------------------------------------------------------
    /**
     * Reseed static values when the adapter version, the account tier digest, or the billing pool identity changes.
     *
     * Invariant: never touch accumulated usage counters. When the semantics become incompatible, set
     * `needs_migration` and stop using the old quota model automatically.
     */
    reseedIfStale(provider, adapter) {
        const init = adapter.init(provider.account);
        const digest = digestOf(provider.account);
        const poolId = poolIdOf(provider, adapter, this.deps.credentials);
        const row = this.deps.db.getProvider(provider.id);
        if (row === null)
            return;
        const versionChanged = row.static_version !== init.version;
        const accountChanged = row.account_digest !== digest;
        // A pool identity contains the credential fingerprint. A process that started without
        // credentials sees 'none'; treating 'none' ↔ a real key as a change would brick the provider
        // for good the first time it boots unauthenticated. Only a real key switching to a different
        // real key is a billing-pool change.
        // The pool identity is compared by its SEMANTIC component — the credential fingerprint —
        // never by the serialized string: a poolId composition revision (serializer change) must
        // not be read as a billing-pool change. The serialization difference is repaired by
        // writeStatic below; the fingerprint is the only part whose change can mean the counters
        // stopped being comparable.
        const oldFingerprint = row.pool_id === null ? 'none' : (row.pool_id.split('|')[1] ?? 'none');
        const newFingerprint = poolId.split('|')[1] ?? 'none';
        const poolChanged = oldFingerprint !== 'none' && newFingerprint !== 'none' && oldFingerprint !== newFingerprint;
        if (!versionChanged && !accountChanged && !poolChanged)
            return;
        const unitChanged = row.unit !== null && row.unit !== init.unit;
        const periodShapeChanged = (row.day_limit !== null && init.dayLimit === null) || (row.month_limit !== null && init.monthLimit === null);
        this.deps.db.writeStatic(provider.id, {
            dayLimit: init.dayLimit,
            monthLimit: init.monthLimit,
            quotaPeriod: init.quotaPeriod,
            unit: init.unit,
            resetTimezone: init.resetTimezone,
            canCharge: init.canCharge,
            staticVersion: init.version,
            accountDigest: digest,
            poolId,
        });
        // Semantically incompatible: the old counters are not comparable with the new limits, stop automatically using the old quota model
        const quotaShapeChanged = row.quota_period !== null && row.quota_period !== init.quotaPeriod;
        if (unitChanged || periodShapeChanged || poolChanged || quotaShapeChanged) {
            this.deps.db.setNeedsMigration(provider.id, true);
            this.deps.db.log({
                providerId: provider.id,
                at: this.deps.now(),
                kind: 'migration',
                detail: poolChanged
                    ? 'billing pool identity changed (credentials or account changed); the old usage cannot be mixed with the new pool, explicit migration required'
                    : `unit or period type changed (unit ${row.unit ?? 'null'} → ${init.unit}); the old counters are not comparable, explicit migration required`,
            });
        }
        this.deps.db.log({
            providerId: provider.id,
            at: this.deps.now(),
            kind: 'static_reseed',
            detail: `version ${row.static_version ?? 'null'} → ${init.version}; dayLimit ${row.day_limit ?? 'null'} → ${init.dayLimit ?? 'null'}; monthLimit ${row.month_limit ?? 'null'} → ${init.monthLimit ?? 'null'}`,
        });
    }
    // ---------------------------------------------------------------------------
    // Gates and resets
    // ---------------------------------------------------------------------------
    /** Perform a lazy reset for a single provider (period boundary, cooldown expiry, credential change, legacy cleanup). */
    applyResetsFor(provider, adapter) {
        const now = this.deps.now();
        const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
        const credentialsPresent = required.every((name) => this.deps.credentials.has(name));
        const fingerprint = this.deps.credentials.fingerprint(required);
        // An invalid timezone makes period key computation throw. **Decide at the load phase**, rather than blowing up at request time.
        const init = adapter.init(provider.account);
        if (!isValidTimezone(init.resetTimezone)) {
            this.disabled.set(provider.id, `adapter declared an invalid timezone: ${init.resetTimezone}`);
            this.deps.db.setNeedsMigration(provider.id, true);
            this.deps.db.log({
                providerId: provider.id,
                at: now,
                kind: 'migration',
                detail: `invalid resetTimezone (${redact(init.resetTimezone, 40)}), the period boundary cannot be determined, stopping automatic use`,
            });
            const rowNow = this.deps.db.getProvider(provider.id);
            return {
                periodResets: [],
                reasonsBefore: rowNow === null ? [] : decodeReasons(rowNow.is_available),
                usableAfter: rowNow !== null && rowNow.is_available === 0,
                rowAfter: rowNow,
            };
        }
        return applyResets(this.deps.db, provider.id, { now, credentialsPresent, credentialFingerprint: fingerprint });
    }
    /**
     * Single-pass read: run the per-provider gates AND assemble the routing candidates in the
     * same scan. Providers that threw are recorded in `failed` (excluded from candidates);
     * `refreshAll` remains for the status path only.
     */
    refreshAndCandidates(exclude) {
        const failed = new Set();
        const candidates = [];
        for (const provider of this.deps.config.providers) {
            const adapter = this.deps.adapters.get(provider.id);
            if (adapter === undefined)
                continue;
            let row;
            try {
                const outcome = this.deps.db.transaction(() => this.applyResetsFor(provider, adapter));
                // The early-exit path (invalid resetTimezone) may carry a null snapshot — the row
                // itself still exists on disk from bootstrap.
                row = outcome.rowAfter ?? this.deps.db.getProvider(provider.id);
            }
            catch (err) {
                failed.add(provider.id);
                this.deps.onDiagnostic?.('refresh_failed', { providerId: provider.id, error: describeError(err) });
                continue;
            }
            if (row === null)
                continue;
            if (exclude.has(provider.id))
                continue;
            // The legacy credential-missing bit is retired: presence is derived on the same pass,
            // from the same config×credentials pair the adapters would consult.
            const allRequiredPresent = provider.credentials
                .filter((c) => c.required)
                .every((c) => this.deps.credentials.has(c.name));
            if (!allRequiredPresent)
                continue;
            candidates.push({
                providerId: provider.id,
                priority: provider.priority,
                isEnable: row.is_enable === 1,
                isAvailable: row.is_available,
                capabilities: adapter.capabilities,
                ...this.derivedAccessibility(provider.id, row),
            });
        }
        return { failed, candidates };
    }
    // ---------------------------------------------------------------------------
    // Candidates and context
    // ---------------------------------------------------------------------------
    contextFor(provider, adapter) {
        return {
            credentials: this.deps.credentials,
            config: provider,
            fetchImpl: this.deps.fetchImpl,
            now: this.deps.now,
            credentialNames: provider.credentials.map((c) => c.name),
        };
    }
    /** Capture the period keys at the request entry point. Usage must be attributed to the period **at request start**. */
    periodsFor(providerId) {
        const row = this.deps.db.getProvider(providerId);
        const timezone = row?.reset_timezone ?? DEFAULT_TIMEZONE;
        const now = this.deps.now();
        return { day: dayKey(timezone, now), month: monthKey(timezone, now) };
    }
    /**
     * The derived unavailability states read out of a row in one place (audit §2.1 / §2.5):
     * a running cooldown (future `retry_after`) and the exhausted-period keys equal to the
     * currently computed keys. An invalid persisted timezone derives nothing (false/null) —
     * an invalid `init` timezone is already disabled at the load phase before a row can be
     * reported with it.
     */
    derivedAccessibility(providerId, row) {
        const now = this.deps.now();
        const cooldownUntil = row.retry_after !== null && row.retry_after > now ? row.retry_after : null;
        if (!isValidTimezone(row.reset_timezone ?? DEFAULT_TIMEZONE)) {
            return { cooldownUntil, dayExhausted: false, monthExhausted: false };
        }
        const timezone = row.reset_timezone ?? DEFAULT_TIMEZONE;
        return {
            cooldownUntil,
            dayExhausted: this.deps.db.readExhaustedKey(providerId, 'day') === dayKey(timezone, now),
            monthExhausted: this.deps.db.readExhaustedKey(providerId, 'month') === monthKey(timezone, now),
        };
    }
    // ---------------------------------------------------------------------------
    // State changes (one short transaction per event)
    // ---------------------------------------------------------------------------
    /**
     * Commit each failure event atomically.
     *
     * The change log and the diagnostic callback record structural labels only — never
     * `Classification.evidence`, which is adapter-supplied free text.
     */
    async applyFailure(providerId, classification, quotaPeriod, provider, adapter) {
        const now = this.deps.now();
        const label = structuralLabel(classification);
        // Lane A (provider-declared reset): the boundary is persisted only for quota refusals whose
        // window length the engine cannot derive (period === null). The declared value from the
        // refusal body wins; otherwise a declaring adapter may be probed — at most once per window,
        // because the stored boundary pre-empts further probes. The probe is a NETWORK call and
        // must run before the transaction (no write tx is ever held across a network request).
        if (classification.kind === 'quota' && classification.period === null) {
            const stored = this.deps.db.readVendorReset(providerId);
            const declared = classification.resetAt;
            if (stored === null && declared === undefined && adapter.probeReset !== undefined) {
                const probed = await adapter.probeReset(this.contextFor(provider, adapter));
                if (probed !== null && probed > now)
                    this.deps.db.writeVendorReset(providerId, probed);
            }
            else if (stored === null && declared !== undefined) {
                if (declared > now)
                    this.deps.db.writeVendorReset(providerId, declared);
            }
        }
        this.deps.db.transaction(() => {
            switch (classification.kind) {
                case 'quota': {
                    // `none` → unknown period. `both` → the classification's period, if it has one.
                    // `day` / `month` → the declared period wins over the classification.
                    const declared = quotaPeriod === 'day' ? 'day' : quotaPeriod === 'month' ? 'month' : null;
                    const period = declared ?? (quotaPeriod === 'both' ? classification.period : null);
                    if (period === null) {
                        // A dedicated bit, not the day/month lanes: those would report a period
                        // that the adapter never declared.
                        this.deps.db.setBits(providerId, BIT.QUOTA_UNKNOWN);
                        this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: 'quota_exhausted_unknown' });
                        this.deps.db.log({
                            providerId,
                            at: now,
                            kind: 'bit_set',
                            detail: `quota_exhausted_unknown (declared=${quotaPeriod})`,
                        });
                        break;
                    }
                    // The exhausted state is the exhausted-period KEY, not a bit (audit §2.5): recovery is
                    // the stored key stopping to equal the current key — one calendar compare, no clear.
                    const row = this.deps.db.getProvider(providerId);
                    const key = period === 'day'
                        ? dayKey(row?.reset_timezone ?? DEFAULT_TIMEZONE, now)
                        : monthKey(row?.reset_timezone ?? DEFAULT_TIMEZONE, now);
                    this.deps.db.writeExhaustedKey(providerId, period, key);
                    this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: `quota_exhausted_${period}` });
                    this.deps.db.log({
                        providerId,
                        at: now,
                        kind: 'exhausted',
                        detail: `quota_exhausted_${period} (declared=${quotaPeriod})`,
                    });
                    break;
                }
                case 'credential_rejected': {
                    this.deps.db.setBits(providerId, BIT.CREDENTIAL_REJECTED);
                    this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: 'credential_rejected' });
                    this.deps.db.log({ providerId, at: now, kind: 'bit_set', detail: label });
                    break;
                }
                case 'transient':
                case 'rate_limited_short': {
                    const row = this.deps.db.getProvider(providerId);
                    const streak = (row?.transient_streak ?? 0) + 1;
                    // A Retry-After given by the provider takes precedence over exponential backoff — it is more accurate than our guess.
                    // Cooldown is pure `retry_after` since audit §2.1 — no bit is written with it.
                    const cooldown = clampCooldown(classification.cooldownMs ?? backoffMs(streak));
                    this.deps.db.setTransientStreak(providerId, streak);
                    this.deps.db.setRetryAfter(providerId, now + cooldown);
                    // A short-window rate limit is the provider refusing this request; a 5xx or a timeout
                    // is our problem to retry, so only the former counts as a rejection.
                    if (classification.kind === 'rate_limited_short') {
                        this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: 'rate_limited_short' });
                    }
                    this.deps.db.log({
                        providerId,
                        at: now,
                        kind: 'cooldown_set',
                        detail: `${classification.kind} (streak ${streak}, cooldown ${cooldown}ms)`,
                    });
                    break;
                }
                case 'our_problem': {
                    // No bit is set: this failure is not provider-specific.
                    this.deps.db.log({ providerId, at: now, kind: 'our_problem', detail: label });
                    break;
                }
                case 'success':
                    break;
            }
        });
        if (classification.kind === 'our_problem') {
            this.deps.onDiagnostic?.('our_problem', { providerId, label });
        }
    }
    /**
     * Wrap-up after a success: clear the cooldown and count the usage, in one short transaction.
     * Usage is attributed to the period keys captured at request start.
     */
    applySuccess(providerId, adapter, account, capability, usage, periods) {
        const now = this.deps.now();
        this.deps.db.transaction(() => {
            // Cooldown recovery on success: null the sole persisted truth (audit §2.1) and zero the
            // streak — no bits are involved.
            this.deps.db.setRetryAfter(providerId, null);
            this.deps.db.setTransientStreak(providerId, 0);
            if (usage <= 0)
                return;
            const init = adapter.init(account);
            if (init.dayLimit !== null)
                this.deps.db.addUsed(providerId, 'day', usage, periods.day);
            if (init.monthLimit !== null)
                this.deps.db.addUsed(providerId, 'month', usage, periods.month);
        });
        this.deps.onDiagnostic?.('success', { providerId, capability, usage });
    }
    // ---------------------------------------------------------------------------
    // Calls
    // ---------------------------------------------------------------------------
    async attempt(capability, call) {
        // Reset. A failure means this provider's state is untrustworthy for this round → do not call it (fail-closed)
        let failed;
        let candidates;
        try {
            const merged = this.refreshAndCandidates(new Set());
            failed = merged.failed;
            candidates = merged.candidates;
        }
        catch (err) {
            return this.storageFailure(capability, describeError(err));
        }
        const plan = planSelection(candidates, capability);
        const attempted = [];
        let storageErrors = 0;
        // Every candidate failed on storage access: go straight to fail-closed.
        if (candidates.length === 0 && failed.size > 0) {
            return this.storageFailure(capability, `state read/write failed for ${failed.size} providers, handled as fail-closed`);
        }
        if (plan.noneWithCapability) {
            return this.buildFailure('config_error', capability, attempted, undefined);
        }
        for (const candidate of plan.ordered) {
            const provider = this.deps.config.providers.find((p) => p.id === candidate.providerId);
            const adapter = this.deps.adapters.get(candidate.providerId);
            if (provider === undefined || adapter === undefined)
                continue;
            // State read failed → do not call this provider this round: better unused than called with unknown state
            let row;
            let periods;
            try {
                row = this.deps.db.getProvider(candidate.providerId);
                periods = this.periodsFor(candidate.providerId);
            }
            catch (err) {
                storageErrors += 1;
                this.deps.onDiagnostic?.('state_read_failed', { providerId: candidate.providerId, error: describeError(err) });
                continue;
            }
            // A provider requiring explicit migration does not take part in automatic quota protection
            if (row === null || row?.needs_migration === 1) {
                attempted.push({
                    providerId: candidate.providerId,
                    classification: { kind: 'our_problem', evidence: 'needs explicit migration (unit/pool/period changed)' },
                });
                continue;
            }
            // Local budget (schema.localCap providers only, e.g. brave): usage reaching the locally
            // declared ceiling is refused before the request — the approximate brake the owner
            // elected for providers whose free tier sits on a saved payment card. Locally counted,
            // never a vendor probe; the period machinery recovers it at the boundary.
            if (adapter.schema.localCap === true && provider.account['capped_free'] !== false) {
                const initNow = adapter.init(provider.account);
                const dayHit = initNow.dayLimit !== null && row.day_used >= initNow.dayLimit;
                const monthHit = initNow.monthLimit !== null && row.month_used >= initNow.monthLimit;
                if (dayHit || monthHit) {
                    const classification = {
                        kind: 'quota',
                        period: monthHit ? 'month' : 'day',
                        evidence: 'locally declared budget ceiling reached (capped_free)',
                    };
                    const attemptedEntry = { providerId: candidate.providerId, classification };
                    try {
                        await this.applyFailure(candidate.providerId, classification, initNow.quotaPeriod, provider, adapter);
                    }
                    catch (err) {
                        // State could not be persisted: fail closed, same as the failure path.
                        this.deps.onDiagnostic?.('state_write_failed', {
                            providerId: candidate.providerId,
                            error: describeError(err),
                        });
                        return this.storageFailure(capability, `failed to write budget-refusal state, handled as fail-closed: ${describeError(err)}`);
                    }
                    attempted.push(attemptedEntry);
                    continue; // budget-braked providers are not attempted this round
                }
            }
            const outcome = await this.callSafely(candidate.providerId, provider, adapter, capability, call);
            if (outcome.ok) {
                try {
                    this.applySuccess(candidate.providerId, adapter, provider.account, capability, outcome.usage, periods);
                }
                catch (err) {
                    // State could not be persisted: fail closed and discard the result rather than return it.
                    this.deps.onDiagnostic?.('state_write_failed', {
                        providerId: candidate.providerId,
                        error: describeError(err),
                    });
                    return this.storageFailure(capability, `failed to write usage state, result discarded (fail-closed): ${describeError(err)}`);
                }
                return { ok: true, provider: candidate.providerId, data: outcome.data };
            }
            try {
                await this.applyFailure(candidate.providerId, outcome.classification, adapter.init(provider.account).quotaPeriod, provider, adapter);
            }
            catch (err) {
                // Failure state could not be persisted either: fail closed, same as the success path.
                this.deps.onDiagnostic?.('state_write_failed', {
                    providerId: candidate.providerId,
                    error: describeError(err),
                });
                return this.storageFailure(capability, `failed to write failure state, handled as fail-closed: ${describeError(err)}`);
            }
            attempted.push({ providerId: candidate.providerId, classification: outcome.classification });
        }
        // A storage failure must not be reported as a config problem.
        if (attempted.length === 0 && storageErrors > 0) {
            return this.storageFailure(capability, `state read failed for ${storageErrors} providers, handled as fail-closed`);
        }
        const allTransient = attempted.length > 0 &&
            attempted.every((a) => a.classification.kind === 'transient' || a.classification.kind === 'rate_limited_short');
        return this.buildFailure(allTransient ? 'all_transient' : 'no_provider_available', capability, attempted, undefined);
    }
    /**
     * Call the adapter, guaranteeing that **exceptions never pierce through the engine**.
     *
     * An adapter throwing is a defect, not a provider problem. The exception text is **always redacted**
     * before being recorded — some fetch errors carry the full URL (including the key in the query).
     */
    async callSafely(providerId, provider, adapter, capability, call) {
        try {
            return await call(this.contextFor(provider, adapter), adapter);
        }
        catch (err) {
            const safe = describeError(err);
            this.deps.onDiagnostic?.('adapter_threw', { providerId, capability, error: safe });
            return { ok: false, classification: { kind: 'our_problem', evidence: `adapter threw: ${safe}` } };
        }
    }
    // ---------------------------------------------------------------------------
    // Failure report
    // ---------------------------------------------------------------------------
    /** State store failure: explicitly tell the caller "it is not safe to call right now" instead of pretending there is no provider. */
    storageFailure(capability, detail) {
        let providers = [];
        try {
            providers = this.reportAll(capability);
        }
        catch {
            providers = [];
        }
        return {
            ok: false,
            reason: 'state_store_error',
            retryable: true,
            retry_after: null,
            providers,
            isolated: this.deps.config.isolated,
            detail,
        };
    }
    buildFailure(reason, capability, attempted, detail) {
        const now = this.deps.now();
        let providers = [];
        try {
            providers = this.reportAll(capability);
        }
        catch (err) {
            // The report itself has to read the DB — if that fails, give only the reason and stop trying
            this.deps.onDiagnostic?.('report_failed', { error: describeError(err) });
            providers = [];
        }
        let retry_after = null;
        if (reason === 'all_transient') {
            const times = providers
                .map((p) => p.resets_at)
                .filter((v) => typeof v === 'number' && v > now);
            retry_after = times.length > 0 ? Math.min(...times) : null;
        }
        return {
            ok: false,
            reason,
            retryable: reason === 'all_transient',
            retry_after,
            providers,
            isolated: this.deps.config.isolated,
            ...(detail === undefined ? {} : { detail }),
        };
    }
    /** List only the providers that **declare this capability** — the rest are noise to the caller. */
    reportAll(capability) {
        const out = [];
        for (const provider of this.deps.config.providers) {
            const adapter = this.deps.adapters.get(provider.id);
            if (adapter === undefined)
                continue;
            if (capability !== null && !adapter.capabilities.includes(capability))
                continue;
            const row = this.deps.db.getProvider(provider.id);
            if (row === null)
                continue;
            out.push(this.reportFor(provider, adapter, row));
        }
        return out;
    }
    reportFor(provider, adapter, row) {
        // Quota day/month and cooldown are derived (audit §2.1/§2.5); the mask still carries the
        // live bits (quota-unknown, credential-rejected) plus the legacy slots of an old file.
        const state = decodeReasons(row.is_available).filter((r) => r !== 'quota_exhausted_day' && r !== 'quota_exhausted_month' && r !== 'transient_failure' && r !== 'rate_limited_short');
        const derived = this.derivedAccessibility(provider.id, row);
        if (derived.monthExhausted)
            state.unshift('quota_exhausted_month');
        if (derived.dayExhausted)
            state.unshift('quota_exhausted_day');
        if (derived.cooldownUntil !== null)
            state.push('cooldown');
        const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
        const missing_env = required.filter((name) => !this.deps.credentials.has(name));
        // Derived credential-missing label occupies the retired bit's snapshot position so the
        // status contract stays stable for callers.
        if (missing_env.length > 0 && !state.includes('credential_missing')) {
            const at = state.findIndex((r) => r === 'quota_exhausted_unknown' || r === 'credential_rejected' || r === 'cooldown');
            state.splice(at === -1 ? state.length : at, 0, 'credential_missing');
        }
        const init = adapter.init(provider.account);
        const needs_migration = row.needs_migration === 1;
        const disabledReason = this.disabled.get(provider.id) ?? null;
        // Period attribution comes from the declared quotaPeriod, never from which bit happens to be set;
        // the derived exhaustion already carries the declared-period gating from the write path.
        let period = null;
        if (derived.dayExhausted && (init.quotaPeriod === 'day' || init.quotaPeriod === 'both'))
            period = 'day';
        if (period === null && derived.monthExhausted && (init.quotaPeriod === 'month' || init.quotaPeriod === 'both')) {
            period = 'month';
        }
        let resets_at = null;
        if (derived.cooldownUntil !== null) {
            resets_at = derived.cooldownUntil;
        }
        else if (period !== null) {
            resets_at = nextPeriodBoundary(period, row.reset_timezone ?? DEFAULT_TIMEZONE, this.deps.now());
        }
        // Usability mirrors routing: the mask, the derived cooldown and the derived quota states
        // join the same predicate — the retired bits live on only as derived states.
        const credentialReady = missing_env.length === 0;
        const usable = !needs_migration && disabledReason === null && row.is_enable === 1
            && credentialReady && row.is_available === 0
            && derived.cooldownUntil === null && !derived.dayExhausted && !derived.monthExhausted;
        return {
            id: provider.id,
            state,
            usable,
            enabled: row.is_enable === 1,
            period,
            resets_at,
            missing_env: missing_env.length > 0 ? missing_env : null,
            needs_migration,
            action_for_llm: actionFor({ state, missing_env, period, needs_migration, disabledReason }),
            rejection_count: this.deps.db.rejectionCount(provider.id),
        };
    }
    // ---------------------------------------------------------------------------
    // Public entry points
    // ---------------------------------------------------------------------------
    async search(req) {
        const result = await this.attempt('search', async (ctx, adapter) => {
            if (adapter.search === undefined) {
                return { ok: false, classification: { kind: 'our_problem', evidence: 'adapter does not implement search' } };
            }
            return adapter.search(ctx, req);
        });
        if (!result.ok)
            return result;
        return { ok: true, data: result.data };
    }
    async fetch(req) {
        const result = await this.attempt('fetch', async (ctx, adapter) => {
            if (adapter.fetch === undefined) {
                return { ok: false, classification: { kind: 'our_problem', evidence: 'adapter does not implement fetch' } };
            }
            return adapter.fetch(ctx, req);
        });
        if (!result.ok)
            return result;
        return { ok: true, data: result.data };
    }
    /** Status path: run the same single pass without candidate filtering. */
    refreshAll() {
        return { failed: this.refreshAndCandidates(new Set()).failed };
    }
    /** State report. A read-only view for the LLM — not a CLI for humans. */
    status(onlyProblems = false) {
        this.refreshAll();
        const out = [];
        for (const provider of this.deps.config.providers) {
            const adapter = this.deps.adapters.get(provider.id);
            if (adapter === undefined)
                continue;
            const row = this.deps.db.getProvider(provider.id);
            if (row === null)
                continue;
            const report = this.reportFor(provider, adapter, row);
            if (onlyProblems && report.usable)
                continue;
            out.push(report);
        }
        return out;
    }
    /** Providers isolated during the config phase. They must be visible rather than silently disappearing. */
    isolatedProviders() {
        return this.deps.config.isolated;
    }
}
/** Account tier digest. */
function digestOf(account) {
    const keys = Object.keys(account).sort();
    return keys.map((k) => `${k}=${JSON.stringify(account[k])}`).join('&');
}
/**
 * Billing pool identity. Determined jointly by the account tier and the **credential fingerprint** —
 * changing credentials means changing account, so the old usage is not comparable with the new pool and
 * `needs_migration` must be set rather than continuing to accumulate.
 * Contains hashes only, never any credential content.
 */
/**
 * Billing-pool identity = the credential fingerprint ONLY (the memo the field comment always
 * claimed). Account fields — region switches like `base_url`, `capped_free`, tier flags — are
 * accounted for by the accountDigest reseed path (writeStatic) and must NOT brick automatic
 * use through `needs_migration`: they never change what a unit means.
 */
function poolIdOf(provider, adapter, credentials) {
    const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
    const fingerprint = credentials.fingerprint(required) ?? 'none';
    return `${adapter.id}|${fingerprint}`;
}
/**
 * The next period boundary, binary-searched to the true boundary; null when it cannot be determined.
 */
export function nextPeriodBoundary(period, timezone, now) {
    if (!isValidTimezone(timezone))
        return null;
    const keyOf = (at) => (period === 'day' ? dayKey(timezone, at) : monthKey(timezone, at));
    const startKey = keyOf(now);
    let lo = now;
    let hi = now + (period === 'day' ? 36 * 60 * 60 * 1000 : 32 * 24 * 60 * 60 * 1000);
    if (keyOf(hi) === startKey)
        return null; // no boundary within the probe window
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (keyOf(mid) === startKey)
            lo = mid;
        else
            hi = mid;
    }
    return hi;
}
/**
 * Structural label: derived only from the classification kind, **containing no free text of any kind**.
 * Used for the persistent log and diagnostics — see the note on `applyFailure`.
 */
function structuralLabel(classification) {
    switch (classification.kind) {
        case 'success':
            return 'success';
        case 'quota':
            return `quota(period=${classification.period ?? 'unknown'})`;
        case 'credential_rejected':
            return 'credential_rejected';
        case 'transient':
            return 'transient';
        case 'rate_limited_short':
            return 'rate_limited_short';
        case 'our_problem':
            return 'our_problem';
    }
}
/** Translate the decoded state into "what to do". This is the key field for the LLM. */
function actionFor(input) {
    const { state, missing_env, period, needs_migration, disabledReason } = input;
    // The load-phase disable reason is the most specific and must win over the generic migration text.
    if (disabledReason !== null) {
        return `disabled: ${redact(disabledReason, 120)}`;
    }
    if (needs_migration) {
        return 'the unit / billing pool / period type has changed, the old usage is not comparable with the new limits, and automatic use has stopped. An explicit migration is required to recover';
    }
    if (state.length === 0)
        return 'usable';
    const actions = [];
    if (missing_env.length > 0)
        actions.push(`ask the user to set the environment variables: ${missing_env.join(', ')}`);
    if (state.includes('credential_rejected'))
        actions.push('credentials rejected by the provider; it will retry automatically once the credentials are replaced');
    if (state.includes('paid_not_allowed'))
        actions.push('this provider may incur charges; the user must explicitly accept paid usage');
    if (period !== null) {
        actions.push(`${period === 'day' ? 'daily' : 'monthly'} quota exhausted, it recovers automatically at the period boundary, retrying now is useless`);
    }
    else if (state.includes('quota_exhausted_unknown')) {
        // The quota really is exhausted, but this provider has no determinable reset period:
        // the recovery time cannot be determined from local state, **do not fabricate it**, and it will **not**
        // recover automatically as time passes
        actions.push('the quota is exhausted and this provider has no determinable reset period, so it will not recover automatically. Manual confirmation, topping up, or replacing the credentials is required');
    }
    else if (state.includes('quota_exhausted_day') || state.includes('quota_exhausted_month')) {
        actions.push('the quota is exhausted, but the reset period cannot be determined; manual confirmation is required');
    }
    if (state.includes('cooldown'))
        actions.push('in cooldown, it recovers automatically later');
    if (state.includes('unknown'))
        actions.push('there are unknown state bits; check version consistency');
    return actions.length > 0 ? actions.join('; ') : 'unusable';
}
//# sourceMappingURL=engine.js.map