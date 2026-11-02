/**
 * P2 derived-state equivalence pins (audit §2.1 cooldown merge / §2.5 exhausted-period key).
 *
 * The contract under proof:
 *  - E1 same candidate selection: a running cooldown or an in-window exhausted key excludes the
 *    provider exactly like the retired bits did;
 *  - E2 visible state: both former cooldown kinds collapse into the one `cooldown` label;
 *  - E3 log semantics: rejection counting and period resets are unchanged;
 *  - E5 old files: legacy slots (cooldown ×2, quota day/month) migrate once, and a still-running
 *    cooldown survives the sweep untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { Engine } from '../src/engine.js';
import { parseConfig } from '../src/config/load.js';
import { loadCredentials } from '../src/credentials/load.js';
import { createSchemaLookup } from '../src/providers/registry.js';
import { BIT } from '../src/db/bits.js';
import { applyResets } from '../src/state/machine.js';
import { dayKey, DEFAULT_TIMEZONE } from '../src/db/period.js';
import type { ProviderAdapter } from '../src/providers/types.js';

const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
const YAML_TAVILY = `
version: 1
allow_paid: true
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: TAVILY_API_KEY
        required: true
    account: {}
`;

function tavilyReturning(failures: number): ProviderAdapter {
  let calls = 0;
  return {
    id: 'tavily',
    capabilities: ['search'],
    schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
    init: () => ({
      version: 1,
      canCharge: false,
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 3000,
      unit: 'requests',
      resetTimezone: 'UTC',
    }),
    search: async () => {
      calls += 1;
      if (calls <= failures) {
        return { ok: false, classification: { kind: 'rate_limited_short', evidence: 'HTTP 429', cooldownMs: 5_000 } };
      }
      return { ok: true, data: [], usage: 1 };
    },
  };
}

test('cooldown merge: a rate_limited_short refusal cools like the old transient bit, label collapses to `cooldown`', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const adapter = tavilyReturning(1);
  const db = SqliteAdapter.open(':memory:', { wal: false }, () => clock.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  const engine = new Engine({
    db,
    config: parseConfig(YAML_TAVILY, { lookup: createSchemaLookup([adapter]) }),
    credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
    adapters: new Map([[adapter.id, adapter]]),
    fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
    now: () => clock.now,
  });
  engine.bootstrap();

  const result = await engine.search({ query: 'x' });
  assert.equal(result.ok, false);
  const report = result.providers.find((p) => p.id === 'tavily');
  assert.ok(report);
  assert.deepEqual(report.state, ['cooldown'], 'both former cooldown kinds collapse into one label (P0-2)');
  assert.equal(report.usable, false);
  assert.equal(report.resets_at, clock.now + 5_000, 'the reported recovery time is the cooldown itself');

  // the mask stays clean: no bit carries the cooldown
  assert.equal(db.getProvider('tavily')?.is_available, 0);
  assert.ok((db.getProvider('tavily')?.retry_after ?? 0) > clock.now);
  db.close();
});

test('cooldown merge: the cooldown survives a fresh engine process on the same DB file and expires exactly', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const dir = mkdtempSync(join(tmpdir(), 'foragix-p2-'));
  const path = join(dir, 'state.db');
  try {
    const adapter = tavilyReturning(1);
    const open = (now: () => number) => {
      const db = SqliteAdapter.open(path, { wal: false }, now);
      applySchema(db, DDL);
      writeSchemaVersion(db);
      return db;
    };
    const make = (now: () => number) => {
      const db = open(now);
      const engine = new Engine({
        db,
        config: parseConfig(YAML_TAVILY, { lookup: createSchemaLookup([adapter]) }),
        credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
        adapters: new Map([[adapter.id, adapter]]),
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
        now,
      });
      engine.bootstrap();
      return { engine, db };
    };

    const first = make(() => clock.now);
    const cooled = await first.engine.search({ query: 'x' });
    assert.equal(cooled.ok, false);
    first.db.close();

    // "second process": a brand-new Engine over the same DB file, still inside the cooldown
    clock.now += 1_000;
    const second = make(() => clock.now);
    const rerun = await second.engine.search({ query: 'x' });
    assert.equal(rerun.ok, false, 'a fresh process must still honour the persisted cooldown');
    assert.ok((rerun.providers.find((p) => p.id === 'tavily')?.resets_at ?? 0) > clock.now);
    second.db.close();

    // past expiry: the same lazily-run gates recover it, no timer anywhere
    clock.now += 4_001;
    const third = make(() => clock.now);
    const recovered = await third.engine.search({ query: 'x' });
    assert.equal(recovered.ok, true, 'the cooldown is derived from retry_after and expires exactly');
    third.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota period-key derivation: exhaustion persists via the key compare, recovers at the boundary with no bit anywhere', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const adapter: ProviderAdapter = {
    id: 'tavily',
    capabilities: ['search'],
    schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
    init: () => ({
      version: 1,
      canCharge: false,
      quotaPeriod: 'both',
      dayLimit: 100,
      monthLimit: 3000,
      unit: 'requests',
      resetTimezone: 'UTC',
    }),
    search: async () => ({ ok: false, classification: { kind: 'quota', period: 'day', evidence: 'daily cap' } }),
  };
  const db = SqliteAdapter.open(':memory:', { wal: false }, () => clock.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  const engine = new Engine({
    db,
    config: parseConfig(YAML_TAVILY, { lookup: createSchemaLookup([adapter]) }),
    credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
    adapters: new Map([[adapter.id, adapter]]),
    fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
    now: () => clock.now,
  });
  engine.bootstrap();

  const refused = await engine.search({ query: 'x' });
  assert.equal(refused.ok, false);
  assert.equal(db.getProvider('tavily')?.is_available, 0, 'no bit is written for a day/month exhaustion');
  assert.equal(db.readExhaustedKey('tavily', 'day'), dayKey(DEFAULT_TIMEZONE, clock.now), 'the exhausted key persists');

  // cross a day boundary: the derived state decays without any clearing write
  clock.now += 24 * 60 * 60 * 1_000;
  const recovered = engine.status(false).find((p) => p.id === 'tavily');
  assert.ok(recovered);
  assert.equal(recovered.period, null, 'the leftover day exhaustion no longer equals the current key');
  assert.equal(recovered.usable, true, 'the boundary recovers it by derivation alone');
  db.close();
});

test('legacy sweep: the four retired slots migrate at refresh and a running cooldown survives untouched', () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const db = SqliteAdapter.open(':memory:', { wal: false }, () => clock.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  db.ensureProvider('p1');
  // an old file: cooldown bits + retry_after still cooling, plus a leftover quota bit
  db.setBits('p1', BIT.TRANSIENT | BIT.QUOTA_MONTH, clock.now + 60_000);

  const before = db.getProvider('p1');
  assert.equal(before?.retry_after, clock.now + 60_000);

  applyResets(db, 'p1', { now: clock.now, credentialsPresent: false, credentialFingerprint: null });
  const row = db.getProvider('p1');
  assert.equal(row?.is_available, 0, 'the legacy slots are swept once');
  assert.equal(row?.retry_after, clock.now + 60_000, 'a still-running cooldown must survive the sweep');

  const clock2 = { now: clock.now + 61_000 };
  const outcome = applyResets(db, 'p1', { now: clock2.now, credentialsPresent: false, credentialFingerprint: null });
  assert.equal(outcome.usableAfter, true, 'the cooldown still resolves through its expiry');
  assert.equal(db.getProvider('p1')?.retry_after, null);
  db.close();
});
