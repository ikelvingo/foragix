/**
 * Regression tests for findings from the reviewer's review.
 *
 * Each test corresponds to one finding in the review, and is named with a number so that it can be checked off one by one during re-review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { Engine, nextPeriodBoundary } from '../src/engine.js';
import { parseConfig } from '../src/config/load.js';
import { ConfigError } from '../src/config/types.js';
import { loadCredentials } from '../src/credentials/load.js';
import { ADAPTERS, createSchemaLookup } from '../src/providers/registry.js';
import { BIT } from '../src/db/bits.js';
import { redact, describeError } from '../src/errors/redact.js';
import { classifyResponse, classifyNetworkError } from '../src/errors/classify.js';
import type { ProviderAdapter } from '../src/providers/types.js';

const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');

interface Canned {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function fakeFetch(routes: Record<string, Canned>): typeof globalThis.fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const route = routes[url];
    if (route === undefined) return new Response('unrouted', { status: 500 });
    return new Response(route.body, { status: route.status, headers: route.headers ?? {} });
  }) as unknown as typeof globalThis.fetch;
}

const CONFIG_TWO = `
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
  - id: exa
    enabled: true
    priority: 20
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;

const TAVILY_OK = JSON.stringify({ results: [{ title: 'T', url: 'https://t.example' }] });
const EXA_OK = JSON.stringify({ results: [{ title: 'E', url: 'https://e.example' }] });

function makeEngine(options: {
  yaml?: string;
  routes?: Record<string, Canned>;
  env?: NodeJS.ProcessEnv;
  adapters?: readonly ProviderAdapter[];
  now?: () => number;
  onDiagnostic?: (event: string, detail: Record<string, unknown>) => void;
  dbPath?: string;
} = {}) {
  const adapters = options.adapters ?? ADAPTERS;
  const config = parseConfig(options.yaml ?? CONFIG_TWO, { lookup: createSchemaLookup(adapters) });
  const credentials = loadCredentials({ env: options.env ?? { TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' } });
  const db = SqliteAdapter.open(options.dbPath ?? ':memory:', { wal: options.dbPath !== undefined }, options.now ?? Date.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  const engine = new Engine({
    db,
    config,
    credentials,
    adapters: new Map(adapters.map((a) => [a.id, a])),
    fetchImpl: fakeFetch(options.routes ?? {}),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  engine.bootstrap();
  return { engine, db, config, close: () => db.close() };
}

// ---------------------------------------------------------------------------
// #1 state changes must be committed in short transactions
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
/**
 * Create a temp workspace whose parent is guaranteed to exist. The harness may sweep the shared
 * tmp root between runs; recreating it here keeps this suite deterministic.
 */
function newTempDir(prefix: string): string {
  const base = join(tmpdir(), 'foragix-tests');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

test('#1 when a transaction throws, everything rolls back and no intermediate state is left behind', () => {
  const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  db.ensureProvider('p1');

  assert.throws(() => {
    db.transaction(() => {
      db.setBits('p1', BIT.QUOTA_MONTH);
      db.addUsed('p1', 'month', 5);
      throw new Error('boom');
    });
  }, /boom/);

  const row = db.getProvider('p1');
  assert.equal(row?.is_available, 0, 'a rollback must not leave the bit set');
  assert.equal(row?.month_used, 0, 'a rollback must not leave the count behind');
  db.close();
});

// ---------------------------------------------------------------------------
// #2 the usage of an in-flight request must be attributed to the period in which the request started
// ---------------------------------------------------------------------------

test('#2 when the period key is advanced during a request, the in-flight request\'s usage is not counted toward the new period', async () => {
  const clock = { now: Date.UTC(2026, 9, 31, 23, 59, 0) }; // 23:59 on the last day of the month

  const adapters = ADAPTERS;
  const config = parseConfig(CONFIG_TWO, { lookup: createSchemaLookup(adapters) });
  const db = SqliteAdapter.open(':memory:', { wal: false }, () => clock.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);

  // while the request is in flight, simulate **another process** performing a lazy reset: advance the period key to November
  const crossingFetch = (async () => {
    clock.now = Date.UTC(2026, 10, 1, 0, 5, 0);
    db.resetPeriod('tavily', 'month', '2026-11');
    db.resetPeriod('tavily', 'day', '2026-11-01');
    return new Response(TAVILY_OK, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine({
    db,
    config,
    credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' } }),
    adapters: new Map(adapters.map((a) => [a.id, a])),
    fetchImpl: crossingFetch,
    now: () => clock.now,
  });
  engine.bootstrap();

  // the reset happens after the request started, so the month key captured at the request entry point is 2026-10
  const before = db.getProvider('tavily');
  assert.equal(before?.month_key, '2026-10');

  const result = await engine.search({ query: 'x' });
  assert.equal(result.ok, true);

  const row = db.getProvider('tavily');
  assert.equal(row?.month_key, '2026-11', 'another process has already advanced the period key');
  assert.equal(row?.month_used, 0, 'the in-flight request belongs to 2026-10, so its usage must not be counted toward 2026-11');
  db.close();
});

test('#2 the addUsed period-key guard: do not accumulate when the key does not match', () => {
  const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);
  db.ensureProvider('p1');
  db.resetPeriod('p1', 'day', '2026-10-29');

  assert.equal(db.addUsed('p1', 'day', 3, '2026-10-29'), true, 'it must accumulate when the key matches');
  assert.equal(db.getProvider('p1')?.day_used, 3);

  assert.equal(db.addUsed('p1', 'day', 5, '2026-10-28'), false, 'it must refuse when the key does not match');
  assert.equal(db.getProvider('p1')?.day_used, 3, 'must not accumulate');
  db.close();
});

// ---------------------------------------------------------------------------
// #3 Retry-After must actually be used
// ---------------------------------------------------------------------------

test('#3 the Retry-After of a short-window 429 is honored, instead of always using exponential backoff', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const h = makeEngine({
    now: () => clock.now,
    routes: {
      'https://api.tavily.com/search': { status: 429, body: 'slow down', headers: { 'retry-after': '30' } },
      'https://api.exa.ai/search': { status: 200, body: EXA_OK },
    },
  });

  await h.engine.search({ query: 'x' });

  const tavily = h.db.getProvider('tavily');
  const cooldown = (tavily?.retry_after ?? 0) - clock.now;
  assert.equal(cooldown, 30_000, 'it must use the Retry-After=30s given by the provider, not the 1s backoff');
  h.close();
});

test('#3 the classification result carries the cooldown duration', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const result = classifyResponse({ status: 429, headers: { 'retry-after': '12' } }, now);
  assert.equal(result.kind, 'rate_limited_short');
  if (result.kind === 'rate_limited_short') {
    assert.equal(result.cooldownMs, 12_000);
  }
});

// ---------------------------------------------------------------------------
// #4 storage failures must fail closed
// ---------------------------------------------------------------------------

test('#4 when the state store is unreadable, return state_store_error instead of calling as usual', async () => {
  const h = makeEngine({ routes: { 'https://api.tavily.com/search': { status: 200, body: TAVILY_OK } } });
  h.db.close(); // simulate a storage failure

  const result = await h.engine.search({ query: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'state_store_error');
    assert.equal(result.retryable, true, 'a storage failure is temporary, so a retry is possible');
  }
});

// ---------------------------------------------------------------------------
// #5 credentials must not enter diagnostics / evidence / logs
// ---------------------------------------------------------------------------

test('#5 tokens in an exception message are redacted', () => {
  assert.ok(!redact('failed for https://api.example.com/v1?api_key=sk-live-abcdef123456').includes('sk-live-abcdef123456'));
  assert.ok(!redact('Bearer tvly-dev-abcdefghijklmnop').includes('tvly-dev-abcdefghijklmnop'));
  // Deliberately shaped like a GitHub PAT so the `ghp` prefix branch is exercised; the value
  // is self-describing nonsense, never a real credential.
  assert.ok(!redact('token=ghp_thisIsAFakeTokenForTestsOnly').includes('ghp_thisIsAFakeTokenForTestsOnly'));
  assert.ok(!redact('key=fc-0123456789abcdef').includes('fc-0123456789abcdef'));
});

test('#5 the evidence for a network error contains no URL query parameters and no token', () => {
  const err = new Error('request to https://api.tavily.com/search?api_key=sk-live-abcdef123456 failed');
  err.name = 'TypeError';
  const result = classifyNetworkError(err);
  assert.equal(result.kind, 'transient');
  assert.ok(!result.evidence.includes('sk-live-abcdef123456'), 'the evidence must not contain a token');
  assert.ok(!result.evidence.includes('api_key'), 'the evidence must not contain query parameters');
});

test('#5 when the adapter throws, neither the diagnostics nor the evidence contain a token', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const boomAdapter: ProviderAdapter = {
    id: 'tavily',
    capabilities: ['search'],
    schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
    init: () => ({
      version: 1,
      canCharge: false,
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 1000,
      unit: 'credits',
      resetTimezone: 'UTC',
    }),
    search: async () => {
      throw new Error('upstream rejected key sk-live-abcdef123456');
    },
  };

  const h = makeEngine({
    adapters: [boomAdapter],
    yaml: `
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
`,
    onDiagnostic: (_event, detail) => seen.push(detail),
  });

  const result = await h.engine.search({ query: 'x' });
  assert.equal(result.ok, false);

  const dump = JSON.stringify({ seen, result });
  assert.ok(!dump.includes('sk-live-abcdef123456'), `credentials must not appear in the diagnostics or the result: ${dump.slice(0, 300)}`);

  const logs = h.db.recentChanges('tavily');
  assert.ok(!JSON.stringify(logs).includes('sk-live-abcdef123456'), 'credentials must not enter the change log');
  h.close();
});

// ---------------------------------------------------------------------------
// #6 the credential names in the config must match the adapter
// ---------------------------------------------------------------------------

test('#6 a credential name in the config that the adapter does not recognize is isolated, instead of being silently let through', () => {
  const yaml = `
version: 1
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: MY_TAVILY_KEY
        required: true
    account: {}
  - id: exa
    enabled: true
    priority: 20
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
  const config = parseConfig(yaml, { lookup: createSchemaLookup(ADAPTERS) });
  assert.equal(config.providers.length, 1, 'tavily must be isolated');
  assert.equal(config.providers[0]?.id, 'exa');
  assert.equal(config.isolated.length, 1);
  assert.equal(config.isolated[0]?.id, 'tavily');
  assert.match(config.isolated[0]?.issues[0]?.message ?? '', /TAVILY_API_KEY/);
});

// ---------------------------------------------------------------------------
// #7 needs_migration must be reflected in the report
// ---------------------------------------------------------------------------

test('#7 a provider with needs_migration must not be shown as usable in the report', () => {
  const h = makeEngine();
  h.db.setNeedsMigration('tavily', true);

  const report = h.engine.status(false).find((p) => p.id === 'tavily');
  assert.ok(report);
  assert.equal(report.usable, false, 'it must not be shown as usable when a migration is required');
  assert.equal(report.needs_migration, true);
  assert.match(report.action_for_llm, /migration/);
  h.close();
});

// ---------------------------------------------------------------------------
// #8 the recovery time must not be fabricated
// ---------------------------------------------------------------------------

test('#8 Exa declares quotaPeriod=month: give the month boundary, instead of fabricating one', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const yaml = `
version: 1
allow_paid: true
providers:
  - id: exa
    enabled: true
    priority: 10
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
  const h = makeEngine({
    yaml,
    now: () => clock.now,
    routes: { 'https://api.exa.ai/search': { status: 402, body: 'no credit' } },
  });

  const result = await h.engine.search({ query: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const exa = result.providers.find((p) => p.id === 'exa');
    assert.ok(exa);
    // Exa is a USD balance model (month_limit is null, it cannot be metered locally),
    // but **the reset period is explicit**: the vendor confirms $10 per month, resetting on the first day of the calendar month.
    // So giving the month boundary is not fabrication, it is backed by evidence.
    assert.equal(exa.period, 'month');
    assert.equal(exa.resets_at, Date.UTC(2026, 10, 1), 'must be the real start-of-month boundary');
  }
  h.close();
});

test('#8 with quotaPeriod=none, period and resets_at are both null, and the state machine does not recover automatically', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const noneAdapter: ProviderAdapter = {
    id: 'tavily',
    capabilities: ['search'],
    schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
    init: () => ({
      version: 1,
      canCharge: false,
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'unknown',
      resetTimezone: 'UTC',
    }),
    search: async () => ({ ok: false, classification: { kind: 'quota', period: null, evidence: 'exhausted' } }),
  };

  const h = makeEngine({
    adapters: [noneAdapter],
    now: () => clock.now,
    yaml: `
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
`,
  });

  const result = await h.engine.search({ query: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const p = result.providers[0];
    assert.ok(p);
    assert.equal(p.period, null, 'there is no determinable reset period');
    assert.equal(p.resets_at, null, 'the recovery time must not be fabricated');
    // express "quota exhausted but the period is unknown" with a **dedicated bit**, not by borrowing the monthly bit —
    // borrowing it would make state read "monthly quota exhausted", contradicting period: null
    assert.deepEqual(p.state, ['quota_exhausted_unknown']);
  }

  // crucial: the state machine layer must not recover automatically either — otherwise it contradicts the report layer
  clock.now += 40 * 24 * 60 * 60 * 1000; // advance past one month
  h.engine.status();
  const row = h.db.getProvider('tavily');
  assert.notEqual(
    (row?.is_available ?? 0) & BIT.QUOTA_UNKNOWN,
    0,
    'with quotaPeriod=none the quota bit must not clear itself as time passes',
  );
  h.close();
});

test('#8 a provider with a monthly cap that runs out of quota gives the real month boundary', async () => {
  const clock = { now: Date.UTC(2026, 9, 29, 12) };
  const h = makeEngine({
    now: () => clock.now,
    routes: {
      'https://api.tavily.com/search': { status: 402, body: 'no credit' },
      'https://api.exa.ai/search': { status: 200, body: EXA_OK },
    },
  });

  await h.engine.search({ query: 'x' });

  const report = h.engine.status(false).find((p) => p.id === 'tavily');
  assert.ok(report);
  assert.equal(report.period, 'month');
  assert.ok(report.resets_at !== null);
  assert.equal(report.resets_at, Date.UTC(2026, 10, 1), 'must be the real start-of-month boundary');
  h.close();
});

// ---------------------------------------------------------------------------
// #9 a provider-level error isolates only that provider
// ---------------------------------------------------------------------------

test('#9 when one provider is misconfigured, the rest can still start', () => {
  const yaml = `
version: 1
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: TAVILY_API_KEY
        required: true
    account:
      not_a_real_option: true
  - id: exa
    enabled: true
    priority: 20
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
  const config = parseConfig(yaml, { lookup: createSchemaLookup(ADAPTERS) });
  assert.equal(config.providers.length, 1, 'exa must be kept');
  assert.equal(config.providers[0]?.id, 'exa');
  assert.equal(config.isolated[0]?.id, 'tavily');
});

test('#9 a startup-level error still refuses to start', () => {
  const yaml = `
version: 99
providers:
  - id: exa
    enabled: true
    priority: 1
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
  assert.throws(() => parseConfig(yaml, { lookup: createSchemaLookup(ADAPTERS) }), ConfigError);
});

test('#9 when every provider is isolated, it still refuses to start', () => {
  const yaml = `
version: 1
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: WRONG_NAME
        required: true
    account: {}
`;
  assert.throws(() => parseConfig(yaml, { lookup: createSchemaLookup(ADAPTERS) }), ConfigError);
});

// ---------------------------------------------------------------------------
// #11 a change of billing pool must trigger a migration
// ---------------------------------------------------------------------------

test('#11 changing credentials changes the billing pool, so old usage must not be mixed into the new pool', () => {
  const yaml = `
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
  const adapters = ADAPTERS;
  const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
  applySchema(db, DDL);
  writeSchemaVersion(db);

  const build = (key: string) =>
    new Engine({
      db,
      config: parseConfig(yaml, { lookup: createSchemaLookup(adapters) }),
      credentials: loadCredentials({ env: { TAVILY_API_KEY: key } }),
      adapters: new Map(adapters.map((a) => [a.id, a])),
      fetchImpl: fakeFetch({}),
    });

  build('key-A').bootstrap();
  db.addUsed('tavily', 'month', 40, null);
  assert.equal(db.getProvider('tavily')?.needs_migration, 0);

  build('key-B').bootstrap(); // credentials were replaced
  assert.equal(db.getProvider('tavily')?.needs_migration, 1, 'changing credentials must set the migration flag');
  assert.equal(db.getProvider('tavily')?.month_used, 40, 're-seeding must never touch the usage counters');

  db.close();
});

// ---------------------------------------------------------------------------
// #12 an invalid timezone must be decided at the load phase
// ---------------------------------------------------------------------------

test('#12 when the timezone declared by the adapter is invalid, that provider is disabled at the load phase', () => {
  const badTz: ProviderAdapter = {
    id: 'tavily',
    capabilities: ['search'],
    schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
    init: () => ({
      version: 1,
      canCharge: false,
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 1000,
      unit: 'credits',
      resetTimezone: 'Not/AZone',
    }),
    search: async () => ({ ok: true, data: [], usage: 0 }),
  };

  const h = makeEngine({
    adapters: [badTz],
    yaml: `
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
`,
  });

  const report = h.engine.status(false).find((p) => p.id === 'tavily');
  assert.ok(report);
  assert.equal(report.usable, false, 'an invalid timezone must disable it, instead of only blowing up at request time');
  assert.match(report.action_for_llm, /invalid timezone/);
  h.close();
});

// ---------------------------------------------------------------------------
// #13 resets_at must be a real boundary
// ---------------------------------------------------------------------------

test('#13 the instant returned by nextPeriodBoundary really does cross the boundary', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const boundary = nextPeriodBoundary('day', 'UTC', now);
  assert.ok(boundary !== null);
  assert.ok(boundary > now, 'the boundary must be later than the current time');
  assert.equal(boundary, Date.UTC(2026, 9, 30), 'under UTC the day boundary is midnight of the next day');
});

test('#13 a different timezone means a different day boundary', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const shanghai = nextPeriodBoundary('day', 'Asia/Shanghai', now);
  assert.equal(shanghai, Date.UTC(2026, 9, 29, 16, 0, 0), 'the day boundary in UTC+8 = 16:00 UTC');
});

test('#13 an invalid timezone returns null, instead of throwing or computing nonsense', () => {
  assert.equal(nextPeriodBoundary('day', 'Not/AZone', Date.now()), null);
});

// ---------------------------------------------------------------------------
// concurrency: two connections operate on different bits at the same time
// ---------------------------------------------------------------------------

test('concurrency: two connections set different bits at the same time without overwriting each other (bitwise OR, not read-modify-write)', () => {
  const dir = newTempDir('foragix-');
  const path = join(dir, 'c.db');
  try {
    const setup = SqliteAdapter.open(path, { wal: true }, Date.now);
    applySchema(setup, DDL);
    writeSchemaVersion(setup);
    setup.ensureProvider('p1');
    setup.close();

    const a = SqliteAdapter.open(path, { wal: true, busyTimeoutMs: 5000 }, Date.now);
    const b = SqliteAdapter.open(path, { wal: true, busyTimeoutMs: 5000 }, Date.now);

    a.setBits('p1', BIT.QUOTA_DAY);
    b.setBits('p1', BIT.CREDENTIAL_MISSING);

    const mask = a.getProvider('p1')?.is_available ?? 0;
    assert.notEqual(mask & BIT.QUOTA_DAY, 0, 'the bit set by a must not be overwritten by b');
    assert.notEqual(mask & BIT.CREDENTIAL_MISSING, 0, 'the bit set by b must not be overwritten by a');

    // clearing a bit likewise must not affect the other bit
    a.clearBits('p1', BIT.QUOTA_DAY);
    const after = b.getProvider('p1')?.is_available ?? 0;
    assert.equal(after & BIT.QUOTA_DAY, 0);
    assert.notEqual(after & BIT.CREDENTIAL_MISSING, 0);

    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
