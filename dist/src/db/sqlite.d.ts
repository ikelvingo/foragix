/** One row of `provider_state`; the column names correspond one-to-one with sql/schema.sql. */
export interface ProviderRow {
    provider_id: string;
    is_enable: number;
    is_available: number;
    retry_after: number | null;
    transient_streak: number;
    day_key: string | null;
    month_key: string | null;
    day_limit: number | null;
    month_limit: number | null;
    unit: string | null;
    reset_timezone: string | null;
    can_charge: number | null;
    day_used: number;
    month_used: number;
    static_version: number | null;
    account_digest: string | null;
    credential_fingerprint: string | null;
    pool_id: string | null;
    /** Quota reset period: day / month / both / none. NULL means it has not been seeded yet. */
    quota_period: string | null;
    needs_migration: number;
    updated_at: number;
}
export type ChangeKind = 'static_reseed' | 'bit_set' | 'bit_clear'
/** Quota exhaustion recorded as an exhausted-period key (audit §2.5) — no bit involved. */
 | 'exhausted'
/** Cooldown recorded as `retry_after` (audit §2.1) — no bit involved. */
 | 'cooldown_set'
/** Cooling end reached; the timestamp lane nulls out. */
 | 'cooldown_clear' | 'period_reset' | 'migration' | 'enable_sync'
/** Classified as "our problem": **no bit is set**, but a trace must be left behind for troubleshooting. */
 | 'our_problem'
/**
 * The provider explicitly refused this request (quota, short-window rate limit, rejected
 * credential). One row per attempt, independent of whether a bit was already set, so that the
 * count can calibrate the optimistic bias of the local counters (runtime design §6).
 */
 | 'rejected';
export interface ChangeEntry {
    providerId: string;
    at: number;
    kind: ChangeKind;
    /** Redacted description. Writing credential values is never allowed. */
    detail?: string;
}
export interface OpenOptions {
    /** busy timeout, in milliseconds. Bounded retries on concurrent write conflicts, avoiding indefinite blocking. */
    busyTimeoutMs?: number;
    /** Whether to enable WAL. The seed file stays on DELETE; the runtime copy should be true. */
    wal?: boolean;
}
export declare class SqliteAdapter {
    private readonly db;
    private readonly now;
    private constructor();
    /**
     * Open the database and complete the basic configuration.
     * Only connection-level settings (WAL / busy_timeout / foreign keys); no schema migration — migration is decided by the caller based on the version.
     */
    static open(path: string, opts?: OpenOptions, now?: () => number): SqliteAdapter;
    close(): void;
    /** Execute a piece of SQL. Only for DDL and migration scripts — business logic should not use it. */
    exec(sql: string): void;
    /**
     * Probe whether a table has the given set of columns (zero-row scan).
     * Used for structural validation at load time: returns false when a column is missing, instead of blowing up only once business SQL hits it.
     */
    canSelect(table: string, columns: string): boolean;
    /** Read one value from schema_meta. */
    readMeta(key: string): string | null;
    writeMeta(key: string, value: string): void;
    /** Insert a default row if this provider has no state row yet (idempotent). */
    ensureProvider(providerId: string): void;
    getProvider(providerId: string): ProviderRow | null;
    /** Provider-declared quota-reset timestamp (lane A): persisted beside the schema metadata,
     *  deliberately NOT a provider_state column — additive state must not disturb the DDL triple-gate. */
    readVendorReset(providerId: string): number | null;
    writeVendorReset(providerId: string, resetAt: number | null): void;
    /** The key of the period in which exhaustion was recorded (audit §2.5): the stored key equals
     *  the currently computed key → the quota state is exhausted; a period change makes them differ
     *  → recovered, no bit and no clear write anywhere. Same schema_meta lane as vendor_reset —
     *  additive state must not disturb the DDL triple-gate. */
    readExhaustedKey(providerId: string, period: 'day' | 'month'): string | null;
    writeExhaustedKey(providerId: string, period: 'day' | 'month', key: string | null): void;
    listProviders(): ProviderRow[];
    /**
     * Set bits. Uses bitwise OR, and **must not** read-modify-write — concurrent processes may be setting other bits at the same time.
     * When setting a transient bit (bit 4/5), retry_after must be given as well.
     */
    setBits(providerId: string, mask: number, retry_after?: number): void;
    /**
     * Clear bits. Uses bitwise AND-NOT, and **must not** read-modify-write.
     *
     * Deliberately does NOT null `retry_after`: since audit §2.1 the cooldown's only persisted
     * truth is `retry_after` (the cooldown bits are retired legacy slots), so a bit clear on a
     * legacy row must never wipe a still-running cooldown. Nulling happens explicitly at expiry
     * or success, in the state machine.
     */
    clearBits(providerId: string, mask: number): void;
    setRetryAfter(providerId: string, at: number | null): void;
    setTransientStreak(providerId: string, streak: number): void;
    setIsEnable(providerId: string, enabled: boolean): void;
    /**
     * Accumulate usage in billing units; the caller computes the delta.
     * Only accumulates when the stored period key still equals `expectedKey`, so an in-flight request
     * that straddles a boundary is not charged to the new period. Returns whether it accumulated.
     * A null `expectedKey` disables the guard.
     */
    addUsed(providerId: string, period: 'day' | 'month', delta: number, expectedKey?: string | null): boolean;
    /** Period reset: zero the counter and advance the period key. **Does not** touch the other period. */
    resetPeriod(providerId: string, period: 'day' | 'month', key: string): void;
    /** Write the static values seeded by adapter init. **Does not** touch day_used / month_used. */
    writeStatic(providerId: string, patch: {
        dayLimit: number | null;
        monthLimit: number | null;
        quotaPeriod: string;
        unit: string | null;
        resetTimezone: string | null;
        canCharge: boolean | null;
        staticVersion: number;
        accountDigest: string;
        poolId: string | null;
    }): void;
    setNeedsMigration(providerId: string, needed: boolean): void;
    /**
     * Write the credential fingerprint.
     * The fingerprint is a hash of (credential value + source identifier) — **never** pass the credential value itself.
     */
    setCredentialFingerprint(providerId: string, fingerprint: string | null): void;
    /** Write one redacted change log entry. */
    log(entry: ChangeEntry): void;
    /**
     * Requests this provider explicitly refused: quota, short-window rate limit, rejected
     * credential. Used to calibrate how optimistic the local counters are (runtime design §6).
     */
    rejectionCount(providerId: string): number;
    /** Read a provider's most recent change records, for the status tool and troubleshooting. */
    recentChanges(providerId: string, limit?: number): Array<{
        at: number;
        kind: string;
        detail: string | null;
    }>;
    /**
     * Run fn inside a transaction.
     * Uses BEGIN IMMEDIATE: it takes the write lock immediately under concurrency, avoiding deadlocks caused by lock upgrades.
     * This transaction **must not** be held during network requests.
     */
    transaction<T>(fn: () => T): T;
}
