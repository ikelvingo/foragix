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
import type { SqliteAdapter } from './db/sqlite.js';
import { type Reason } from './db/bits.js';
import type { Config, IsolatedProvider } from './config/types.js';
import type { CredentialView } from './credentials/load.js';
import type { FetchDocument, InformationDocument, InformationRequest, ProviderAdapter, SearchHit } from './providers/types.js';
export type FailureReason = 'no_provider_available' | 'all_transient' | 'config_error' | 'state_store_error' | 'no_match' | 'partial_results';
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
export type SearchResult = {
    readonly ok: true;
    readonly data: readonly SearchHit[];
} | FailureReport;
export type FetchResult = {
    readonly ok: true;
    readonly data: FetchDocument;
} | FailureReport;
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
export declare class Engine {
    private readonly deps;
    /** Providers judged unusable during the load phase (invalid timezone, initialization failure, etc.). */
    private readonly disabled;
    constructor(deps: EngineDeps);
    /**
     * Load-phase initialization: state rows, enable flag, static value seeding, gate sync, period key initialization.
     *
     * **The first call performs no initialization at all** — it all happens here.
     * A single provider failing to initialize does not affect the other providers: it is recorded in disabled and exposed in the state report.
     */
    bootstrap(): void;
    /**
     * Reseed static values when the adapter version, the account tier digest, or the billing pool identity changes.
     *
     * Invariant: never touch accumulated usage counters. When the semantics become incompatible, set
     * `needs_migration` and stop using the old quota model automatically.
     */
    private reseedIfStale;
    /** Perform a lazy reset for a single provider (period boundary, cooldown expiry, credential change, legacy cleanup). */
    private applyResetsFor;
    /**
     * Single-pass read: run the per-provider gates AND assemble the routing candidates in the
     * same scan. Providers that threw are recorded in `failed` (excluded from candidates);
     * `refreshAll` remains for the status path only.
     */
    private refreshAndCandidates;
    private contextFor;
    /** Capture the period keys at the request entry point. Usage must be attributed to the period **at request start**. */
    private periodsFor;
    /**
     * The derived unavailability states read out of a row in one place (audit §2.1 / §2.5):
     * a running cooldown (future `retry_after`) and the exhausted-period keys equal to the
     * currently computed keys. An invalid persisted timezone derives nothing (false/null) —
     * an invalid `init` timezone is already disabled at the load phase before a row can be
     * reported with it.
     */
    private derivedAccessibility;
    /**
     * Commit each failure event atomically.
     *
     * The change log and the diagnostic callback record structural labels only — never
     * `Classification.evidence`, which is adapter-supplied free text.
     */
    private applyFailure;
    /**
     * Wrap-up after a success: clear the cooldown and count the usage, in one short transaction.
     * Usage is attributed to the period keys captured at request start.
     */
    private applySuccess;
    private attempt;
    /**
     * Call the adapter, guaranteeing that **exceptions never pierce through the engine**.
     *
     * An adapter throwing is a defect, not a provider problem. The exception text is **always redacted**
     * before being recorded — some fetch errors carry the full URL (including the key in the query).
     */
    private callSafely;
    /** State store failure: explicitly tell the caller "it is not safe to call right now" instead of pretending there is no provider. */
    private storageFailure;
    private buildFailure;
    /** List only the providers that **declare this capability** — the rest are noise to the caller. */
    private reportAll;
    private reportFor;
    search(req: {
        query: string;
        maxResults?: number;
        site?: 'zhihu';
    }): Promise<SearchResult>;
    information(req: InformationRequest): Promise<{
        ok: true;
        data: InformationDocument;
    } | FailureReport>;
    fetch(req: {
        url: string;
    }): Promise<FetchResult>;
    /** Status path: run the same single pass without candidate filtering. */
    private refreshAll;
    /** State report. A read-only view for the LLM — not a CLI for humans. */
    status(onlyProblems?: boolean): ProviderReport[];
    /** Providers isolated during the config phase. They must be visible rather than silently disappearing. */
    isolatedProviders(): readonly IsolatedProvider[];
}
/**
 * The next period boundary, binary-searched to the true boundary; null when it cannot be determined.
 */
export declare function nextPeriodBoundary(period: 'day' | 'month', timezone: string, now: number): number | null;
