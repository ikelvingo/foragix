/**
 * The only module that touches `node:sqlite` (still experimental upstream).
 * Persistence primitives only — bit and reset decisions belong to the caller.
 */
import { DatabaseSync } from 'node:sqlite';
import { isKnownMask, TRANSIENT_BIT_MASK } from './bits.js';

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

export type ChangeKind =
  | 'static_reseed'
  | 'bit_set'
  | 'bit_clear'
  /** Quota exhaustion recorded as an exhausted-period key (audit §2.5) — no bit involved. */
  | 'exhausted'
  /** Cooldown recorded as `retry_after` (audit §2.1) — no bit involved. */
  | 'cooldown_set'
  /** Cooling end reached; the timestamp lane nulls out. */
  | 'cooldown_clear'
  | 'period_reset'
  | 'migration'
  | 'enable_sync'
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

/** Current journal mode of an open connection; 'unknown' when the pragma cannot be read. */
function currentJournalMode(db: DatabaseSync): string {
  try {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface OpenOptions {
  /** busy timeout, in milliseconds. Bounded retries on concurrent write conflicts, avoiding indefinite blocking. */
  busyTimeoutMs?: number;
  /** Whether to enable WAL. The seed file stays on DELETE; the runtime copy should be true. */
  wal?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export class SqliteAdapter {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  private constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /**
   * Open the database and complete the basic configuration.
   * Only connection-level settings (WAL / busy_timeout / foreign keys); no schema migration — migration is decided by the caller based on the version.
   */
  static open(path: string, opts: OpenOptions = {}, now: () => number = Date.now): SqliteAdapter {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = ON');
    // Skipped when the file is already in WAL: the upgrade takes a write lock, and on some
    // filesystems that wait is not bounded by busy_timeout — a second process would then hang
    // inside open() instead of simply joining the existing WAL database.
    if (opts.wal === true && currentJournalMode(db) !== 'wal') db.exec('PRAGMA journal_mode = WAL');
    return new SqliteAdapter(db, now);
  }

  close(): void {
    this.db.close();
  }

  /** Execute a piece of SQL. Only for DDL and migration scripts — business logic should not use it. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Probe whether a table has the given set of columns (zero-row scan).
   * Used for structural validation at load time: returns false when a column is missing, instead of blowing up only once business SQL hits it.
   */
  canSelect(table: string, columns: string): boolean {
    try {
      this.db.prepare(`SELECT ${columns} FROM ${table} LIMIT 0`).all();
      return true;
    } catch {
      return false;
    }
  }

  /** Read one value from schema_meta. */
  readMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
    return (row as unknown as { value: string } | undefined)?.value ?? null;
  }

  writeMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Insert a default row if this provider has no state row yet (idempotent). */
  ensureProvider(providerId: string): void {
    this.db
      .prepare(
        `INSERT INTO provider_state (provider_id, updated_at)
         VALUES (?, ?)
         ON CONFLICT(provider_id) DO NOTHING`,
      )
      .run(providerId, this.now());
  }

  getProvider(providerId: string): ProviderRow | null {
    const row = this.db.prepare('SELECT * FROM provider_state WHERE provider_id = ?').get(providerId);
    return (row as unknown as ProviderRow | undefined) ?? null;
  }

  /** Provider-declared quota-reset timestamp (lane A): persisted beside the schema metadata,
   *  deliberately NOT a provider_state column — additive state must not disturb the DDL triple-gate. */
  readVendorReset(providerId: string): number | null {
    const raw = this.readMeta(`vendor_reset:${providerId}`);
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  writeVendorReset(providerId: string, resetAt: number | null): void {
    if (resetAt === null) {
      this.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(`vendor_reset:${providerId}`);
      return;
    }
    this.writeMeta(`vendor_reset:${providerId}`, String(resetAt));
  }

  /** The key of the period in which exhaustion was recorded (audit §2.5): the stored key equals
   *  the currently computed key → the quota state is exhausted; a period change makes them differ
   *  → recovered, no bit and no clear write anywhere. Same schema_meta lane as vendor_reset —
   *  additive state must not disturb the DDL triple-gate. */
  readExhaustedKey(providerId: string, period: 'day' | 'month'): string | null {
    return this.readMeta(`exhausted_${period}:${providerId}`);
  }

  writeExhaustedKey(providerId: string, period: 'day' | 'month', key: string | null): void {
    if (key === null) {
      this.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(`exhausted_${period}:${providerId}`);
      return;
    }
    this.writeMeta(`exhausted_${period}:${providerId}`, key);
  }

  listProviders(): ProviderRow[] {
    return this.db.prepare('SELECT * FROM provider_state ORDER BY provider_id').all() as unknown as ProviderRow[];
  }

  /**
   * Set bits. Uses bitwise OR, and **must not** read-modify-write — concurrent processes may be setting other bits at the same time.
   * When setting a transient bit (bit 4/5), retry_after must be given as well.
   */
  setBits(providerId: string, mask: number, retry_after?: number): void {
    if (!isKnownMask(mask)) throw new Error(`Illegal bitmask: ${mask}`);
    if (mask === 0) return;
    const needsRetry = (mask & TRANSIENT_BIT_MASK) !== 0;
    if (needsRetry && retry_after === undefined) {
      throw new Error('retry_after must be given when setting a transient bit (bit 4/5)');
    }
    const now = this.now();
    if (needsRetry && retry_after !== undefined) {
      this.db
        .prepare('UPDATE provider_state SET is_available = is_available | ?, retry_after = ?, updated_at = ? WHERE provider_id = ?')
        .run(mask, retry_after, now, providerId);
    } else {
      this.db
        .prepare('UPDATE provider_state SET is_available = is_available | ?, updated_at = ? WHERE provider_id = ?')
        .run(mask, now, providerId);
    }
  }

  /**
   * Clear bits. Uses bitwise AND-NOT, and **must not** read-modify-write.
   *
   * Deliberately does NOT null `retry_after`: since audit §2.1 the cooldown's only persisted
   * truth is `retry_after` (the cooldown bits are retired legacy slots), so a bit clear on a
   * legacy row must never wipe a still-running cooldown. Nulling happens explicitly at expiry
   * or success, in the state machine.
   */
  clearBits(providerId: string, mask: number): void {
    if (!isKnownMask(mask)) throw new Error(`Illegal bitmask: ${mask}`);
    if (mask === 0) return;
    const now = this.now();
    this.db
      .prepare('UPDATE provider_state SET is_available = is_available & ~?, updated_at = ? WHERE provider_id = ?')
      .run(mask, now, providerId);
  }

  setRetryAfter(providerId: string, at: number | null): void {
    this.db
      .prepare('UPDATE provider_state SET retry_after = ?, updated_at = ? WHERE provider_id = ?')
      .run(at, this.now(), providerId);
  }

  setTransientStreak(providerId: string, streak: number): void {
    this.db
      .prepare('UPDATE provider_state SET transient_streak = ?, updated_at = ? WHERE provider_id = ?')
      .run(streak, this.now(), providerId);
  }

  setIsEnable(providerId: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE provider_state SET is_enable = ?, updated_at = ? WHERE provider_id = ?')
      .run(enabled ? 1 : 0, this.now(), providerId);
  }

  /**
   * Accumulate usage in billing units; the caller computes the delta.
   * Only accumulates when the stored period key still equals `expectedKey`, so an in-flight request
   * that straddles a boundary is not charged to the new period. Returns whether it accumulated.
   * A null `expectedKey` disables the guard.
   */
  addUsed(providerId: string, period: 'day' | 'month', delta: number, expectedKey: string | null = null): boolean {
    if (!Number.isFinite(delta) || delta < 0) throw new Error(`Illegal usage delta: ${delta}`);
    const usedColumn = period === 'day' ? 'day_used' : 'month_used';
    const keyColumn = period === 'day' ? 'day_key' : 'month_key';
    const now = this.now();

    const info =
      expectedKey === null
        ? this.db
            .prepare(`UPDATE provider_state SET ${usedColumn} = ${usedColumn} + ?, updated_at = ? WHERE provider_id = ?`)
            .run(delta, now, providerId)
        : this.db
            .prepare(
              `UPDATE provider_state
                  SET ${usedColumn} = ${usedColumn} + ?, updated_at = ?
                WHERE provider_id = ? AND ${keyColumn} = ?`,
            )
            .run(delta, now, providerId, expectedKey);

    return Number(info.changes) > 0;
  }

  /** Period reset: zero the counter and advance the period key. **Does not** touch the other period. */
  resetPeriod(providerId: string, period: 'day' | 'month', key: string): void {
    const keyColumn = period === 'day' ? 'day_key' : 'month_key';
    const usedColumn = period === 'day' ? 'day_used' : 'month_used';
    this.db
      .prepare(
        `UPDATE provider_state
            SET ${keyColumn} = ?, ${usedColumn} = 0, updated_at = ?
          WHERE provider_id = ?`,
      )
      .run(key, this.now(), providerId);
  }

  /** Write the static values seeded by adapter init. **Does not** touch day_used / month_used. */
  writeStatic(
    providerId: string,
    patch: {
      dayLimit: number | null;
      monthLimit: number | null;
      quotaPeriod: string;
      unit: string | null;
      resetTimezone: string | null;
      canCharge: boolean | null;
      staticVersion: number;
      accountDigest: string;
      poolId: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE provider_state
            SET day_limit = ?, month_limit = ?, quota_period = ?, unit = ?, reset_timezone = ?,
                can_charge = ?, static_version = ?, account_digest = ?, pool_id = ?, updated_at = ?
          WHERE provider_id = ?`,
      )
      .run(
        patch.dayLimit,
        patch.monthLimit,
        patch.quotaPeriod,
        patch.unit,
        patch.resetTimezone,
        patch.canCharge === null ? null : patch.canCharge ? 1 : 0,
        patch.staticVersion,
        patch.accountDigest,
        patch.poolId,
        this.now(),
        providerId,
      );
  }

  setNeedsMigration(providerId: string, needed: boolean): void {
    this.db
      .prepare('UPDATE provider_state SET needs_migration = ?, updated_at = ? WHERE provider_id = ?')
      .run(needed ? 1 : 0, this.now(), providerId);
  }

  /**
   * Write the credential fingerprint.
   * The fingerprint is a hash of (credential value + source identifier) — **never** pass the credential value itself.
   */
  setCredentialFingerprint(providerId: string, fingerprint: string | null): void {
    this.db
      .prepare('UPDATE provider_state SET credential_fingerprint = ?, updated_at = ? WHERE provider_id = ?')
      .run(fingerprint, this.now(), providerId);
  }

  /** Write one redacted change log entry. */
  log(entry: ChangeEntry): void {
    this.db
      .prepare('INSERT INTO provider_change_log (provider_id, at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(entry.providerId, entry.at, entry.kind, entry.detail ?? null);
  }

  /**
   * Requests this provider explicitly refused: quota, short-window rate limit, rejected
   * credential. Used to calibrate how optimistic the local counters are (runtime design §6).
   */
  rejectionCount(providerId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM provider_change_log WHERE provider_id = ? AND kind = 'rejected'")
      .get(providerId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Read a provider's most recent change records, for the status tool and troubleshooting. */
  recentChanges(providerId: string, limit = 10): Array<{ at: number; kind: string; detail: string | null }> {
    return this.db
      .prepare('SELECT at, kind, detail FROM provider_change_log WHERE provider_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(providerId, limit) as unknown as Array<{ at: number; kind: string; detail: string | null }>;
  }

  /**
   * Run fn inside a transaction.
   * Uses BEGIN IMMEDIATE: it takes the write lock immediately under concurrency, avoiding deadlocks caused by lock upgrades.
   * This transaction **must not** be held during network requests.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* a failed rollback must not mask the original error */
      }
      throw err;
    }
  }
}
