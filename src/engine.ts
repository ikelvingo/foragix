/**
 * Core orchestration: config, credentials, state, routing and adapters.
 *
 * Contracts:
 *  - Usable means `is_enable = 1` and `is_available = 0`; nothing is computed, predicted or ranked.
 *  - The caller is an LLM: normal responses carry no quota information.
 *  - Initialization happens only at load time; the request path does lazy resets only.
 *  - Each state event is one short transaction; no write transaction is held across a network call.
 *  - On a state store failure, fail closed and report `state_store_error`.
 */
import type { SqliteAdapter, ProviderRow } from './db/sqlite.js';
import { BIT, decodeReasons, type Reason } from './db/bits.js';
import { dayKey, isValidTimezone, monthKey, DEFAULT_TIMEZONE } from './db/period.js';
import { applyResets } from './state/machine.js';
import { planSelection, type Candidate } from './routing/select.js';
import type { ResetOutcome } from './state/machine.js';
import { effectiveAllowPaid } from './config/load.js';
import type { Config, IsolatedProvider, ProviderConfig } from './config/types.js';
import type { CredentialView } from './credentials/load.js';
import { backoffMs, clampCooldown, type Classification } from './errors/classify.js';
import { describeError, redact } from './errors/redact.js';
import type {
  AdapterContext,
  AdapterOutcome,
  Capability,
  FetchDocument,
  ProviderAdapter,
  SearchHit,
} from './providers/types.js';

export type FailureReason =
  | 'no_provider_available'
  | 'all_transient'
  | 'config_error'
  | 'state_store_error';

export interface ProviderReport {
  readonly id: string;
  /** Reason decoded from the bitmask. **For reporting only, never used in decisions.** */
  readonly state: Reason[];
  readonly usable: boolean;
  readonly enabled: boolean;
  /** If a quota period is exhausted, which period it is. **null when it cannot be determined.** */
  readonly period: 'day' | 'month' | null;
  /** Recovery time; **null when unknown, and must never be fabricated**. */
  readonly resets_at: number | null;
  /** Missing credential environment variable names (names only, never values). */
  readonly missing_env: readonly string[] | null;
  /** Explicit migration required (unit / billing pool / period type has changed). */
  readonly needs_migration: boolean;
  readonly action_for_llm: string;
  /** Requests this provider explicitly refused; see runtime design §6. */
  readonly rejection_count: number;
}

export interface FailureReport {
  readonly ok: false;
  readonly reason: FailureReason;
  readonly retryable: boolean;
  /** Earliest retry time; null if none. */
  readonly retry_after: number | null;
  readonly providers: readonly ProviderReport[];
  /** Providers isolated during the config phase. They are not in the providers list, but they must be visible. */
  readonly isolated: readonly IsolatedProvider[];
  /** Human-readable failure reason (redacted). */
  readonly detail?: string;
}

// The success payload carries the results and nothing else (config format §10.1): which provider
// served the request is internal routing, and the caller already knows which tool it invoked.
export type SearchResult =
  | { readonly ok: true; readonly data: readonly SearchHit[] }
  | FailureReport;

export type FetchResult =
  | { readonly ok: true; readonly data: FetchDocument }
  | FailureReport;

export interface EngineDeps {
  readonly db: SqliteAdapter;
  readonly config: Config;
  readonly credentials: CredentialView;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly fetchImpl: typeof globalThis.fetch;
  /** Clock injection point, for testing. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Diagnostic output. **Must never contain credential values** — the text handed out is already redacted. */
  readonly onDiagnostic?: (event: string, detail: Record<string, unknown>) => void;
}

/** Period context captured at the request entry point. Used to attribute the usage of an in-flight request to the period **in which it started**. */
interface RequestPeriod {
  readonly day: string;
  readonly month: string;
}

export class Engine {
  private readonly deps: EngineDeps & { now: () => number };
  /** Providers judged unusable during the load phase (invalid timezone, initialization failure, etc.). */
  private readonly disabled = new Map<string, string>();

  constructor(deps: EngineDeps) {
    this.deps = { ...deps, now: deps.now ?? Date.now };
  }

  /**
   * Load-phase initialization: state rows, enable flag, static value seeding, gate sync, period key initialization.
   *
   * **The first call performs no initialization at all** — it all happens here.
   * A single provider failing to initialize does not affect the other providers: it is recorded in disabled and exposed in the state report.
   */
  bootstrap(): void {
    for (const provider of this.deps.config.providers) {
      const adapter = this.deps.adapters.get(provider.id);
      if (adapter === undefined) continue; // config validation already guarantees this cannot happen

      try {
        this.deps.db.transaction(() => {
          this.deps.db.ensureProvider(provider.id);
          this.deps.db.setIsEnable(provider.id, provider.enabled);
          this.reseedIfStale(provider, adapter);
            this.applyResetsFor(provider, adapter);
        });
      } catch (err) {
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
  private reseedIfStale(provider: ProviderConfig, adapter: ProviderAdapter): void {
    const init = adapter.init(provider.account);
    const digest = digestOf(provider.account);
    const poolId = poolIdOf(provider, adapter, this.deps.credentials);
    const row = this.deps.db.getProvider(provider.id);
    if (row === null) return;

    const versionChanged = row.static_version !== init.version;
    const accountChanged = row.account_digest !== digest;
    // A pool identity contains the credential fingerprint. A process that started without
    // credentials sees 'none'; treating 'none' ↔ a real key as a change would brick the provider
    // for good the first time it boots unauthenticated. Only a real key switching to a different
    // real key is a billing-pool change.
    const oldFingerprint = row.pool_id === null ? 'none' : (row.pool_id.split('|')[2] ?? 'none');
    const newFingerprint = poolId.split('|')[2] ?? 'none';
    const poolChanged =
      row.pool_id !== null && row.pool_id !== poolId && oldFingerprint !== 'none' && newFingerprint !== 'none';
    if (!versionChanged && !accountChanged && !poolChanged) return;

    const unitChanged = row.unit !== null && row.unit !== init.unit;
    const periodShapeChanged =
      (row.day_limit !== null && init.dayLimit === null) || (row.month_limit !== null && init.monthLimit === null);

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
  private applyResetsFor(provider: ProviderConfig, adapter: ProviderAdapter): ResetOutcome {
    const now = this.deps.now();
    const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
    const credentialsPresent = required.every((name) => this.deps.credentials.has(name));
    const fingerprint = this.deps.credentials.fingerprint(required);
    const allowPaid = effectiveAllowPaid(this.deps.config, provider);

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

    return applyResets(this.deps.db, provider.id, { now, credentialsPresent, credentialFingerprint: fingerprint, allowPaid });
  }

  /**
   * Single-pass read: run the per-provider gates AND assemble the routing candidates in the
   * same scan. Providers that threw are recorded in `failed` (excluded from candidates);
   * `refreshAll` remains for the status path only.
   */
  private refreshAndCandidates(exclude: ReadonlySet<string>): { failed: Set<string>; candidates: Candidate[] } {
    const failed = new Set<string>();
    const candidates: Candidate[] = [];
    for (const provider of this.deps.config.providers) {
      const adapter = this.deps.adapters.get(provider.id);
      if (adapter === undefined) continue;
      let row: ProviderRow | null;
      try {
        const outcome: ResetOutcome = this.deps.db.transaction(() => this.applyResetsFor(provider, adapter));
        // The early-exit path (invalid resetTimezone) may carry a null snapshot — the row
        // itself still exists on disk from bootstrap.
        row = outcome.rowAfter ?? this.deps.db.getProvider(provider.id);
      } catch (err) {
        failed.add(provider.id);
        this.deps.onDiagnostic?.('refresh_failed', { providerId: provider.id, error: describeError(err) });
        continue;
      }
      if (row === null) continue;
      if (exclude.has(provider.id)) continue;
      // The legacy credential-missing bit is retired: presence is derived on the same pass,
      // from the same config×credentials pair the adapters would consult.
      const allRequiredPresent = provider.credentials
        .filter((c) => c.required)
        .every((c) => this.deps.credentials.has(c.name));
      if (!allRequiredPresent) continue;
      candidates.push({
        providerId: provider.id,
        priority: provider.priority,
        isEnable: row.is_enable === 1,
        isAvailable: row.is_available,
        capabilities: adapter.capabilities,
      });
    }
    return { failed, candidates };
  }

  // ---------------------------------------------------------------------------
  // Candidates and context
  // ---------------------------------------------------------------------------


  private contextFor(provider: ProviderConfig, adapter: ProviderAdapter): AdapterContext {
    return {
      credentials: this.deps.credentials,
      config: provider,
      fetchImpl: this.deps.fetchImpl,
      now: this.deps.now,
      credentialNames: provider.credentials.map((c) => c.name),
    };
  }

  /** Capture the period keys at the request entry point. Usage must be attributed to the period **at request start**. */
  private periodsFor(providerId: string): RequestPeriod {
    const row = this.deps.db.getProvider(providerId);
    const timezone = row?.reset_timezone ?? DEFAULT_TIMEZONE;
    const now = this.deps.now();
    return { day: dayKey(timezone, now), month: monthKey(timezone, now) };
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
  private async applyFailure(
    providerId: string,
    classification: Classification,
    quotaPeriod: string,
    provider: ProviderConfig,
    adapter: ProviderAdapter,
  ): Promise<void> {
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
        if (probed !== null && probed > now) this.deps.db.writeVendorReset(providerId, probed);
      } else if (stored === null && declared !== undefined) {
        if (declared > now) this.deps.db.writeVendorReset(providerId, declared);
      }
    }

    this.deps.db.transaction(() => {
      switch (classification.kind) {
        case 'quota': {
          // `none` → unknown period. `both` → the classification's period, if it has one.
          // `day` / `month` → the declared period wins over the classification.
          const declared: 'day' | 'month' | null =
            quotaPeriod === 'day' ? 'day' : quotaPeriod === 'month' ? 'month' : null;
          const period = declared ?? (quotaPeriod === 'both' ? classification.period : null);

          if (period === null) {
            // A dedicated bit, not the day/month bits: those would report a month
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

          const bit = period === 'day' ? BIT.QUOTA_DAY : BIT.QUOTA_MONTH;
          this.deps.db.setBits(providerId, bit);
          this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: `quota_exhausted_${period}` });
          this.deps.db.log({
            providerId,
            at: now,
            kind: 'bit_set',
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
          const bit = classification.kind === 'transient' ? BIT.TRANSIENT : BIT.RATE_LIMITED_SHORT;
          // A Retry-After given by the provider takes precedence over exponential backoff — it is more accurate than our guess
          const cooldown = clampCooldown(classification.cooldownMs ?? backoffMs(streak));
          this.deps.db.setTransientStreak(providerId, streak);
          this.deps.db.setBits(providerId, bit, now + cooldown);
          // A short-window rate limit is the provider refusing this request; a 5xx or a timeout
          // is our problem to retry, so only the former counts as a rejection.
          if (classification.kind === 'rate_limited_short') {
            this.deps.db.log({ providerId, at: now, kind: 'rejected', detail: 'rate_limited_short' });
          }
          this.deps.db.log({
            providerId,
            at: now,
            kind: 'bit_set',
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
  private applySuccess(
    providerId: string,
    adapter: ProviderAdapter,
    account: Readonly<Record<string, unknown>>,
    capability: Capability,
    usage: number,
    periods: RequestPeriod,
  ): void {
    const now = this.deps.now();
    this.deps.db.transaction(() => {
      this.deps.db.clearBits(providerId, BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT);
      this.deps.db.setRetryAfter(providerId, null);
      this.deps.db.setTransientStreak(providerId, 0);

      if (usage <= 0) return;
      const init = adapter.init(account);
      if (init.dayLimit !== null) this.deps.db.addUsed(providerId, 'day', usage, periods.day);
      if (init.monthLimit !== null) this.deps.db.addUsed(providerId, 'month', usage, periods.month);
    });

    this.deps.onDiagnostic?.('success', { providerId, capability, usage });
  }

  // ---------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------

  private async attempt<T>(
    capability: Capability,
    call: (ctx: AdapterContext, adapter: ProviderAdapter) => Promise<AdapterOutcome<T>>,
  ): Promise<{ ok: true; provider: string; data: T } | FailureReport> {
    // Reset. A failure means this provider's state is untrustworthy for this round → do not call it (fail-closed)
    let failed: Set<string>;
    let candidates: Candidate[];
    try {
      const merged = this.refreshAndCandidates(new Set<string>());
      failed = merged.failed;
      candidates = merged.candidates;
    } catch (err) {
      return this.storageFailure(capability, describeError(err));
    }

    const plan = planSelection(candidates, capability);
    const attempted: Array<{ providerId: string; classification: Classification }> = [];
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
      if (provider === undefined || adapter === undefined) continue;

      // State read failed → do not call this provider this round: better unused than called with unknown state
      let row: ProviderRow | null;
      let periods: RequestPeriod;
      try {
        row = this.deps.db.getProvider(candidate.providerId);
        periods = this.periodsFor(candidate.providerId);
      } catch (err) {
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
          const classification: Classification = {
            kind: 'quota',
            period: monthHit ? 'month' : 'day',
            evidence: 'locally declared budget ceiling reached (capped_free)',
          };
          const attemptedEntry = { providerId: candidate.providerId, classification };
          try {
            await this.applyFailure(candidate.providerId, classification, initNow.quotaPeriod, provider, adapter);
          } catch (err) {
            // State could not be persisted: fail closed, same as the failure path.
            this.deps.onDiagnostic?.('state_write_failed', {
              providerId: candidate.providerId,
              error: describeError(err),
            });
            return this.storageFailure(
              capability,
              `failed to write budget-refusal state, handled as fail-closed: ${describeError(err)}`,
            );
          }
          attempted.push(attemptedEntry);
          continue; // budget-braked providers are not attempted this round
        }
      }

      const outcome = await this.callSafely(candidate.providerId, provider, adapter, capability, call);

      if (outcome.ok) {        try {
          this.applySuccess(candidate.providerId, adapter, provider.account, capability, outcome.usage, periods);
        } catch (err) {
          // State could not be persisted: fail closed and discard the result rather than return it.
          this.deps.onDiagnostic?.('state_write_failed', {
            providerId: candidate.providerId,
            error: describeError(err),
          });
          return this.storageFailure(
            capability,
            `failed to write usage state, result discarded (fail-closed): ${describeError(err)}`,
          );
        }
        return { ok: true, provider: candidate.providerId, data: outcome.data };
      }

      try {
        await this.applyFailure(candidate.providerId, outcome.classification, adapter.init(provider.account).quotaPeriod, provider, adapter);
      } catch (err) {
        // Failure state could not be persisted either: fail closed, same as the success path.
        this.deps.onDiagnostic?.('state_write_failed', {
          providerId: candidate.providerId,
          error: describeError(err),
        });
        return this.storageFailure(
          capability,
          `failed to write failure state, handled as fail-closed: ${describeError(err)}`,
        );
      }
      attempted.push({ providerId: candidate.providerId, classification: outcome.classification });
    }

    // A storage failure must not be reported as a config problem.
    if (attempted.length === 0 && storageErrors > 0) {
      return this.storageFailure(capability, `state read failed for ${storageErrors} providers, handled as fail-closed`);
    }

    const allTransient =
      attempted.length > 0 &&
      attempted.every((a) => a.classification.kind === 'transient' || a.classification.kind === 'rate_limited_short');
    return this.buildFailure(allTransient ? 'all_transient' : 'no_provider_available', capability, attempted, undefined);
  }

  /**
   * Call the adapter, guaranteeing that **exceptions never pierce through the engine**.
   *
   * An adapter throwing is a defect, not a provider problem. The exception text is **always redacted**
   * before being recorded — some fetch errors carry the full URL (including the key in the query).
   */
  private async callSafely<T>(
    providerId: string,
    provider: ProviderConfig,
    adapter: ProviderAdapter,
    capability: Capability,
    call: (ctx: AdapterContext, adapter: ProviderAdapter) => Promise<AdapterOutcome<T>>,
  ): Promise<AdapterOutcome<T>> {
    try {
      return await call(this.contextFor(provider, adapter), adapter);
    } catch (err) {
      const safe = describeError(err);
      this.deps.onDiagnostic?.('adapter_threw', { providerId, capability, error: safe });
      return { ok: false, classification: { kind: 'our_problem', evidence: `adapter threw: ${safe}` } };
    }
  }

  // ---------------------------------------------------------------------------
  // Failure report
  // ---------------------------------------------------------------------------

  /** State store failure: explicitly tell the caller "it is not safe to call right now" instead of pretending there is no provider. */
  private storageFailure(capability: Capability, detail: string): FailureReport {
    let providers: ProviderReport[] = [];
    try {
      providers = this.reportAll(capability);
    } catch {
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

  private buildFailure(
    reason: FailureReason,
    capability: Capability,
    attempted: ReadonlyArray<{ providerId: string; classification: Classification }>,
    detail: string | undefined,
  ): FailureReport {
    const now = this.deps.now();
    let providers: ProviderReport[] = [];
    try {
      providers = this.reportAll(capability);
    } catch (err) {
      // The report itself has to read the DB — if that fails, give only the reason and stop trying
      this.deps.onDiagnostic?.('report_failed', { error: describeError(err) });
      providers = [];
    }

    let retry_after: number | null = null;
    if (reason === 'all_transient') {
      const times = providers
        .map((p) => p.resets_at)
        .filter((v): v is number => typeof v === 'number' && v > now);
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
  private reportAll(capability: Capability | null): ProviderReport[] {
    const out: ProviderReport[] = [];
    for (const provider of this.deps.config.providers) {
      const adapter = this.deps.adapters.get(provider.id);
      if (adapter === undefined) continue;
      if (capability !== null && !adapter.capabilities.includes(capability)) continue;
      const row = this.deps.db.getProvider(provider.id);
      if (row === null) continue;
      out.push(this.reportFor(provider, adapter, row));
    }
    return out;
  }

  private reportFor(provider: ProviderConfig, adapter: ProviderAdapter, row: ProviderRow): ProviderReport {
    const state = decodeReasons(row.is_available);
    const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
    const missing_env = required.filter((name) => !this.deps.credentials.has(name));
    // Derived credential-missing label occupies the retired bit's snapshot position so the
    // status contract stays stable for callers.
    if (missing_env.length > 0 && !state.includes('credential_missing')) {
      const at = state.findIndex((r) => r === 'quota_exhausted_unknown' || r === 'credential_rejected' || r === 'transient_failure');
      state.splice(at === -1 ? state.length : at, 0, 'credential_missing');
    }
    const init = adapter.init(provider.account);
    const needs_migration = row.needs_migration === 1;
    const disabledReason = this.disabled.get(provider.id) ?? null;

    // Period attribution comes from the declared quotaPeriod, never from which bit happens to be set.
    let period: 'day' | 'month' | null = null;
    if (init.quotaPeriod === 'day' || init.quotaPeriod === 'both') {
      if ((row.is_available & BIT.QUOTA_DAY) !== 0) period = 'day';
    }
    if (period === null && (init.quotaPeriod === 'month' || init.quotaPeriod === 'both')) {
      if ((row.is_available & BIT.QUOTA_MONTH) !== 0) period = 'month';
    }

    let resets_at: number | null = null;
    if ((row.is_available & (BIT.TRANSIENT | BIT.RATE_LIMITED_SHORT)) !== 0) {
      resets_at = row.retry_after;
    } else if (period !== null) {
      resets_at = nextPeriodBoundary(period, row.reset_timezone ?? DEFAULT_TIMEZONE, this.deps.now());
    }

    // Usability mirrors routing: the legacy credential bit is retired, so the derived
    // config×credentials predicate joins the availability check here as well.
    const credentialReady = missing_env.length === 0;
    const usable = !needs_migration && disabledReason === null && row.is_enable === 1
      && credentialReady && row.is_available === 0;

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

  async search(req: { query: string; maxResults?: number }): Promise<SearchResult> {
    const result = await this.attempt<readonly SearchHit[]>('search', async (ctx, adapter) => {
      if (adapter.search === undefined) {
        return { ok: false, classification: { kind: 'our_problem', evidence: 'adapter does not implement search' } };
      }
      return adapter.search(ctx, req);
    });
    if (!result.ok) return result;
    return { ok: true, data: result.data };
  }

  async fetch(req: { url: string }): Promise<FetchResult> {
    const result = await this.attempt<FetchDocument>('fetch', async (ctx, adapter) => {
      if (adapter.fetch === undefined) {
        return { ok: false, classification: { kind: 'our_problem', evidence: 'adapter does not implement fetch' } };
      }
      return adapter.fetch(ctx, req);
    });
    if (!result.ok) return result;
    return { ok: true, data: result.data };
  }

  /** Status path: run the same single pass without candidate filtering. */
  private refreshAll(): { failed: Set<string> } {
    return { failed: this.refreshAndCandidates(new Set<string>()).failed };
  }

  /** State report. A read-only view for the LLM — not a CLI for humans. */
  status(onlyProblems = false): ProviderReport[] {
    this.refreshAll();
    const out: ProviderReport[] = [];
    for (const provider of this.deps.config.providers) {
      const adapter = this.deps.adapters.get(provider.id);
      if (adapter === undefined) continue;
      const row = this.deps.db.getProvider(provider.id);
      if (row === null) continue;
      const report = this.reportFor(provider, adapter, row);
      if (onlyProblems && report.usable) continue;
      out.push(report);
    }
    return out;
  }

  /** Providers isolated during the config phase. They must be visible rather than silently disappearing. */
  isolatedProviders(): readonly IsolatedProvider[] {
    return this.deps.config.isolated;
  }
}

/** Account tier digest. */
function digestOf(account: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(account).sort();
  return keys.map((k) => `${k}=${JSON.stringify(account[k])}`).join('&');
}

/**
 * Billing pool identity. Determined jointly by the account tier and the **credential fingerprint** —
 * changing credentials means changing account, so the old usage is not comparable with the new pool and
 * `needs_migration` must be set rather than continuing to accumulate.
 * Contains hashes only, never any credential content.
 */
function poolIdOf(provider: ProviderConfig, adapter: ProviderAdapter, credentials: CredentialView): string {
  const required = provider.credentials.filter((c) => c.required).map((c) => c.name);
  const fingerprint = credentials.fingerprint(required) ?? 'none';
  return `${adapter.id}|${digestOf(provider.account)}|${fingerprint}`;
}

/**
 * The next period boundary, binary-searched to the true boundary; null when it cannot be determined.
 */
export function nextPeriodBoundary(period: 'day' | 'month', timezone: string, now: number): number | null {
  if (!isValidTimezone(timezone)) return null;
  const keyOf = (at: number): string => (period === 'day' ? dayKey(timezone, at) : monthKey(timezone, at));
  const startKey = keyOf(now);

  let lo = now;
  let hi = now + (period === 'day' ? 36 * 60 * 60 * 1000 : 32 * 24 * 60 * 60 * 1000);
  if (keyOf(hi) === startKey) return null; // no boundary within the probe window

  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (keyOf(mid) === startKey) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Structural label: derived only from the classification kind, **containing no free text of any kind**.
 * Used for the persistent log and diagnostics — see the note on `applyFailure`.
 */
function structuralLabel(classification: Classification): string {
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
function actionFor(input: {
  state: readonly Reason[];
  missing_env: readonly string[];
  period: 'day' | 'month' | null;
  needs_migration: boolean;
  disabledReason: string | null;
}): string {
  const { state, missing_env, period, needs_migration, disabledReason } = input;

  // The load-phase disable reason is the most specific and must win over the generic migration text.
  if (disabledReason !== null) {
    return `disabled: ${redact(disabledReason, 120)}`;
  }
  if (needs_migration) {
    return 'the unit / billing pool / period type has changed, the old usage is not comparable with the new limits, and automatic use has stopped. An explicit migration is required to recover';
  }
  if (state.length === 0) return 'usable';

  const actions: string[] = [];
  if (missing_env.length > 0) actions.push(`ask the user to set the environment variables: ${missing_env.join(', ')}`);
  if (state.includes('credential_rejected')) actions.push('credentials rejected by the provider; it will retry automatically once the credentials are replaced');
  if (state.includes('paid_not_allowed')) actions.push('this provider may incur charges; the user must explicitly accept paid usage');
  if (period !== null) {
    actions.push(`${period === 'day' ? 'daily' : 'monthly'} quota exhausted, it recovers automatically at the period boundary, retrying now is useless`);
  } else if (state.includes('quota_exhausted_unknown')) {
    // The quota really is exhausted, but this provider has no determinable reset period:
    // the recovery time cannot be determined from local state, **do not fabricate it**, and it will **not**
    // recover automatically as time passes
    actions.push('the quota is exhausted and this provider has no determinable reset period, so it will not recover automatically. Manual confirmation, topping up, or replacing the credentials is required');
  } else if (state.includes('quota_exhausted_day') || state.includes('quota_exhausted_month')) {
    actions.push('the quota is exhausted, but the reset period cannot be determined; manual confirmation is required');
  }
  if (state.includes('transient_failure')) actions.push('in cooldown after a transient failure, it recovers automatically later');
  if (state.includes('rate_limited_short')) actions.push('in cooldown after short-window rate limiting, it recovers automatically later');
  if (state.includes('unknown')) actions.push('there are unknown state bits; check version consistency');
  return actions.length > 0 ? actions.join('; ') : 'unusable';
}
