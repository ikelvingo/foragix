-- Authoritative runtime state schema; seed/foragix.db is generated from it by scripts/build-seed.mjs and is a derived artifact of it: it must not be edited by hand.
-- journal_mode is deliberately not set here: the seed stays in the default (DELETE) mode so it ships as a single file; WAL is enabled by the runtime on its own copy.

PRAGMA foreign_keys = ON;

-- Schema metadata (keys: schema_version, schema_ddl_hash); read at load time to decide whether a migration is needed
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per provider. is_available is a bitmask: 0 = available, non-zero records the reasons bit by bit.
CREATE TABLE IF NOT EXISTS provider_state (
  provider_id      TEXT    PRIMARY KEY,

  -- Config side: synced from the config file's `enabled`
  is_enable        INTEGER NOT NULL DEFAULT 0,

  -- Runtime side: disable reasons as a bitmask; several can coexist and only a mask of zero means available
  is_available     INTEGER NOT NULL DEFAULT 0,

  -- Expiry of the transient bits (bit 4 / bit 5), unix ms; must be set when either of them is set
  retry_after      INTEGER,

  -- Consecutive transient failures, used only to compute backoff; reset to zero on success
  transient_streak INTEGER NOT NULL DEFAULT 0,

  -- Period keys (computed in that provider's own timezone)
  day_key          TEXT,
  month_key        TEXT,

  -- day_limit / month_limit: the quota ceiling that can be counted locally; NULL = it cannot be counted locally.
  -- unit = the billing unit (adapter-fixed); reset_timezone = the timezone of the period keys; can_charge = the provider may incur real charges
  day_limit        INTEGER,
  month_limit      INTEGER,
  unit             TEXT,
  reset_timezone   TEXT,
  can_charge       INTEGER,

  day_used         INTEGER NOT NULL DEFAULT 0,
  month_used       INTEGER NOT NULL DEFAULT 0,

  -- The period the quota resets on: day / month / both / none, independent of day_limit / month_limit (which only say
  -- whether the quota can be counted locally). A quota bit is cleared only at its matching period boundary; `none` means
  -- there is no determinable reset period, and that bit is then cleared only by an external event.
  quota_period     TEXT,

  -- Reseed decision: adapter version number + account tier digest
  static_version   INTEGER,
  account_digest   TEXT,

  -- Credential fingerprint: stores only a hash (credential value + source identifier), never the credential value or
  -- any reversible form of it; a different hash means the credential was replaced
  credential_fingerprint TEXT,

  -- Billing pool identifier: an irreversible digest of the account tier + credential source, never a raw value. When it changes, the account or billing pool has changed and the old usage is not comparable with the new pool
  pool_id          TEXT,

  -- 1 after a semantically incompatible change (unit / billing pool / period type): the old counters are not comparable with
  -- the new limits, so the old quota model is not used automatically until an explicit migration
  needs_migration  INTEGER NOT NULL DEFAULT 0,

  updated_at       INTEGER NOT NULL DEFAULT 0
);

-- Change log of reseeds, bit set/clear, period resets and migrations; `at` is unix ms. Only redacted information is recorded: credential values are never written.
CREATE TABLE IF NOT EXISTS provider_change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_provider
  ON provider_change_log (provider_id, at DESC);
