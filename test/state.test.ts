import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { BIT, decodeReasons } from '../src/db/bits.js';
import { applyResets } from '../src/state/machine.js';

const DAY = 24 * 60 * 60 * 1000;

/** The authoritative DDL. By design the adapter layer performs no schema migration, so the test applies it itself. */
const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');

function openDb(clock: { now: number }): SqliteAdapter {
  const db = SqliteAdapter.open(':memory:', { wal: false }, () => clock.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  db.ensureProvider('p1');
  return db;
}

function ctx(clock: { now: number }, overrides: Partial<Parameters<typeof applyResets>[2]> = {}) {
  return {
    now: clock.now,
    credentialsPresent: false,
    credentialFingerprint: null,
    allowPaid: false,
    ...overrides,
  };
}

test('the first call initializes the period keys and does not falsely report a period reset', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  const outcome = applyResets(db, 'p1', ctx(clock));
  assert.deepEqual(outcome.periodResets, [], 'the first initialization must not count as a period reset');
  const row = db.getProvider('p1');
  assert.equal(row?.day_key, '2026-10-29');
  assert.equal(row?.month_key, '2026-10');
  db.close();
});

test('a day boundary clears the daily quota bit and zeroes the day counter; the month counter is unaffected', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));

  db.setBits('p1', BIT.QUOTA_DAY | BIT.QUOTA_MONTH);
  db.addUsed('p1', 'day', 7);
  db.addUsed('p1', 'month', 300);

  clock.now += DAY; // crosses a day, not a month
  const outcome = applyResets(db, 'p1', ctx(clock));

  assert.deepEqual(outcome.periodResets, ['day']);
  const row = db.getProvider('p1');
  assert.equal(row?.day_used, 0, 'the day counter should be zeroed');
  assert.equal(row?.month_used, 300, 'the month counter must not be zeroed by the day period');
  assert.equal(row?.is_available & BIT.QUOTA_DAY, 0, 'the daily quota bit should be cleared');
  assert.notEqual(row?.is_available & BIT.QUOTA_MONTH, 0, 'the monthly quota bit should be preserved');
  db.close();
});

test('crossing a month necessarily crosses a day too: each period resets on its own and both counters go to zero', () => {
  const clock = { now: Date.UTC(2026, 9, 31, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));
  db.setBits('p1', BIT.QUOTA_MONTH | BIT.QUOTA_DAY);
  db.addUsed('p1', 'day', 5);
  db.addUsed('p1', 'month', 900);

  clock.now += DAY; // 2026-10-31 → 2026-11-01, crossing both the day boundary and the month boundary
  const outcome = applyResets(db, 'p1', ctx(clock));

  assert.deepEqual([...outcome.periodResets].sort(), ['day', 'month']);
  const row = db.getProvider('p1');
  assert.equal(row?.day_key, '2026-11-01');
  assert.equal(row?.month_key, '2026-11');
  assert.equal(row?.day_used, 0, 'entering a new day, the day counter should go to zero');
  assert.equal(row?.month_used, 0, 'entering a new month, the month counter should go to zero');
  assert.equal(row?.is_available, 0, 'both quota bits should be cleared');
  db.close();
});

test('multiple reasons coexist: clearing one of the bits must not make the provider usable', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));

  db.setBits('p1', BIT.CREDENTIAL_MISSING | BIT.QUOTA_MONTH);
  assert.deepEqual(decodeReasons(db.getProvider('p1')?.is_available ?? 0), [
    'quota_exhausted_month',
    'credential_missing',
  ]);

  // credentials are supplied; only the credential bit should be cleared
  const outcome = applyResets(
    db,
    'p1',
    ctx(clock, { credentialsPresent: true, credentialFingerprint: 'fp-1' }),
  );
  assert.equal(outcome.usableAfter, false, 'the monthly quota is still exhausted, so it must not become usable');
  assert.deepEqual(decodeReasons(db.getProvider('p1')?.is_available ?? 0), ['quota_exhausted_month']);
  db.close();
});

test('clearing bits is a bitwise operation and does not overwrite other bits that coexist', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));

  db.setBits('p1', BIT.CREDENTIAL_MISSING | BIT.PAID_NOT_ALLOWED | BIT.QUOTA_DAY);
  db.clearBits('p1', BIT.CREDENTIAL_MISSING);

  const mask = db.getProvider('p1')?.is_available ?? 0;
  assert.equal(mask & BIT.CREDENTIAL_MISSING, 0, 'the cleared bit should be zeroed');
  assert.notEqual(mask & BIT.PAID_NOT_ALLOWED, 0, 'bits not involved must be preserved exactly as they were');
  assert.notEqual(mask & BIT.QUOTA_DAY, 0, 'bits not involved must be preserved exactly as they were');
  db.close();
});

test('a transient bit recovers automatically once it expires', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));

  db.setBits('p1', BIT.TRANSIENT, clock.now + 60_000);
  assert.notEqual(db.getProvider('p1')?.is_available, 0);

  clock.now += 30_000;
  applyResets(db, 'p1', ctx(clock));
  assert.notEqual(db.getProvider('p1')?.is_available, 0, 'the cooldown has not expired, so it should not recover');

  // past the 60s expiry: recovers
  clock.now += 31_000;
  const outcome = applyResets(db, 'p1', ctx(clock));
  assert.equal(outcome.usableAfter, true);
  assert.equal(db.getProvider('p1')?.retry_after, null, 'after recovery, retry_after should be cleared');
  db.close();
});

test('setting a transient bit requires an expiry time — otherwise the recovery condition cannot be determined', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  assert.throws(() => db.setBits('p1', BIT.TRANSIENT), /retry_after/);
  db.close();
});

test('a rejected credential recovers only after the credential fingerprint changes, not merely because "credentials are present"', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));

  db.setBits('p1', BIT.CREDENTIAL_REJECTED);

  // credentials present and the fingerprint matches the record → not cleared
  applyResets(db, 'p1', ctx(clock, { credentialsPresent: true, credentialFingerprint: 'fp-A' }));
  assert.notEqual(
    (db.getProvider('p1')?.is_available ?? 0) & BIT.CREDENTIAL_REJECTED,
    0,
    'the fingerprint has not changed, so it should not recover',
  );

  // fingerprint changed → cleared
  applyResets(db, 'p1', ctx(clock, { credentialsPresent: true, credentialFingerprint: 'fp-B' }));
  assert.equal(
    (db.getProvider('p1')?.is_available ?? 0) & BIT.CREDENTIAL_REJECTED,
    0,
    'after the fingerprint changes it should recover',
  );
  db.close();
});

test('credential missing coexists with quota exhausted in the bitmask, each unaffected by the other', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));
  db.setBits('p1', BIT.CREDENTIAL_MISSING | BIT.QUOTA_DAY);
  const before = db.getProvider('p1')?.is_available ?? 0;
  assert.equal(before & BIT.CREDENTIAL_MISSING, BIT.CREDENTIAL_MISSING);
  assert.equal(before & BIT.QUOTA_DAY, BIT.QUOTA_DAY);
  db.close();
});

test('legacy credential/paid slots are migrated on the next refresh, boundary or not', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));
  db.setBits('p1', BIT.CREDENTIAL_MISSING | BIT.PAID_NOT_ALLOWED | BIT.QUOTA_DAY);

  clock.now += DAY * 2;
  applyResets(db, 'p1', ctx(clock));

  const mask = db.getProvider('p1')?.is_available ?? 0;
  assert.equal(mask & BIT.QUOTA_DAY, 0, 'the quota bit should be cleared by the period boundary');
  assert.equal(mask & BIT.CREDENTIAL_MISSING, 0, 'the retired credential slot is migrated away');
  assert.equal(mask & BIT.PAID_NOT_ALLOWED, 0, 'the retired paid slot is migrated away');
  db.close();
});

test('the change log records the period reset and contains no credential values', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = openDb(clock);
  applyResets(db, 'p1', ctx(clock));
  clock.now += DAY;
  applyResets(db, 'p1', ctx(clock));

  const log = db.recentChanges('p1');
  assert.ok(log.some((e) => e.kind === 'period_reset'), 'a period reset should be recorded');
  for (const entry of log) {
    assert.ok(!/secret|token|key=/i.test(entry.detail ?? ''), 'the log must not contain credentials');
  }
  db.close();
});
