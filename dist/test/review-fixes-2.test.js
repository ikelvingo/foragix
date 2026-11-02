/**
 * Regression tests for the findings of the second review round.
 *
 * They correspond to the "not actually fixed" items and the "new problems introduced by the fix"
 * that the Reviewer called out in round two.
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
import { ADAPTERS, createSchemaLookup } from '../src/providers/registry.js';
import { BIT } from '../src/db/bits.js';
import { redact, describeError } from '../src/errors/redact.js';
import { classifyResponse } from '../src/errors/classify.js';
const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
const CONFIG_TAVILY = `
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
const TAVILY_OK = JSON.stringify({ results: [{ title: 'T', url: 'https://t.example' }] });
function makeEngine(options = {}) {
    const adapters = options.adapters ?? ADAPTERS;
    const config = parseConfig(options.yaml ?? CONFIG_TAVILY, { lookup: createSchemaLookup(adapters) });
    const credentials = loadCredentials({ env: { TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' } });
    const db = SqliteAdapter.open(':memory:', { wal: false }, options.now ?? Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const routes = options.routes ?? {};
    const fetchImpl = (async (input) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);
        const route = routes[url];
        if (route === undefined)
            return new Response('unrouted', { status: 500 });
        return new Response(route.body, { status: route.status, headers: route.headers ?? {} });
    });
    const engine = new Engine({
        db,
        config,
        credentials,
        adapters: new Map(adapters.map((a) => [a.id, a])),
        fetchImpl,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
    engine.bootstrap();
    return { engine, db, close: () => db.close() };
}
// ---------------------------------------------------------------------------
// #3 Retry-After: above the cap it must still take effect (truncated to 60s),
// not fall back to a 1-second backoff
// ---------------------------------------------------------------------------
import { mkdirSync } from 'node:fs';
/**
 * Create a temp workspace whose parent is guaranteed to exist. The harness may sweep the shared
 * tmp root between runs; recreating it here keeps this suite deterministic.
 */
function newTempDir(prefix) {
    const base = join(tmpdir(), 'foragix-tests');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
}
test('#3 a Retry-After above 60 seconds is truncated to 60 seconds, not fallen back to a 1-second backoff', async () => {
    const clock = { now: Date.UTC(2026, 9, 29, 12) };
    const h = makeEngine({
        now: () => clock.now,
        routes: {
            'https://api.tavily.com/search': { status: 429, body: 'slow down', headers: { 'retry-after': '120' } },
        },
    });
    await h.engine.search({ query: 'x' });
    const cooldown = (h.db.getProvider('tavily')?.retry_after ?? 0) - clock.now;
    assert.equal(cooldown, 60_000, 'Retry-After=120s should be truncated to the 60s cap, not fallen back to 1s');
    h.close();
});
test('#3 classification layer: a Retry-After of any size is carried into cooldownMs and clamped', () => {
    const now = Date.UTC(2026, 9, 29, 12);
    for (const [header, expected] of [
        ['1', 1_000],
        ['30', 30_000],
        ['60', 60_000],
        ['120', 60_000],
        ['99999', 60_000],
    ]) {
        const result = classifyResponse({ status: 429, headers: { 'retry-after': header } }, now);
        assert.equal(result.kind, 'rate_limited_short');
        if (result.kind === 'rate_limited_short') {
            assert.equal(result.cooldownMs, expected, `Retry-After: ${header}`);
        }
    }
});
// ---------------------------------------------------------------------------
// #4 fail-closed: when the usage write fails, the result must not be handed to the caller
// ---------------------------------------------------------------------------
test('#4 on success with a failed usage write, return state_store_error and no result', async () => {
    const adapters = ADAPTERS;
    const config = parseConfig(CONFIG_TAVILY, { lookup: createSchemaLookup(adapters) });
    const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    // The request returns successfully, but the DB is closed before the final state write — simulating "we got the result, but the state cannot be written"
    const fetchImpl = (async () => {
        const response = new Response(TAVILY_OK, { status: 200 });
        db.close();
        return response;
    });
    const engine = new Engine({
        db,
        config,
        credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' } }),
        adapters: new Map(adapters.map((a) => [a.id, a])),
        fetchImpl,
    });
    engine.bootstrap();
    const result = await engine.search({ query: 'x' });
    assert.equal(result.ok, false, 'when the state cannot be persisted, the result must not be handed to the caller');
    if (!result.ok) {
        assert.equal(result.reason, 'state_store_error');
        assert.match(result.detail ?? '', /fail-closed/);
    }
});
// ---------------------------------------------------------------------------
// #5 an external message must not reach diagnostics / logs (not "kept after redaction",
// but "not kept at all")
// ---------------------------------------------------------------------------
test('#5 describeError discards the message, keeping only the error name and error code', () => {
    const err = new Error('authorization: arbitrary-secret-value');
    err.name = 'TypeError';
    err.code = 'ECONNRESET';
    const out = describeError(err);
    assert.equal(out, 'TypeError: ECONNRESET');
    assert.ok(!out.includes('arbitrary-secret-value'), 'the message must be discarded entirely');
});
test('#5 no unusual credential shape leaks through describeError', () => {
    for (const message of [
        'authorization: arbitrary-secret-value',
        'api_token_value=somecustomtoken123',
        'provider returned credential ABCDEFGHIJKLMNOP',
        'X-Custom-Key: zzzz9999yyyy8888',
    ]) {
        const out = describeError(new Error(message));
        assert.ok(!out.includes(message), `must not contain the original message: ${out}`);
    }
});
test('#5 when an adapter returns ok:false with a token of its own in evidence, neither the logs nor the result contain it', async () => {
    const token = 'arbitrary-secret-value';
    const leakyAdapter = {
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
        search: async () => ({
            ok: false,
            classification: { kind: 'credential_rejected', evidence: `authorization: ${token}` },
        }),
    };
    const seen = [];
    const h = makeEngine({
        adapters: [leakyAdapter],
        onDiagnostic: (_e, d) => seen.push(d),
    });
    const result = await h.engine.search({ query: 'x' });
    const dump = JSON.stringify({ seen, result, logs: h.db.recentChanges('tavily') });
    assert.ok(!dump.includes(token), `the credential must not appear in any output: ${dump.slice(0, 400)}`);
    h.close();
});
test('#5 redact is best-effort: known shapes are replaced (but no security guarantee is claimed)', () => {
    assert.ok(!redact('Bearer tvly-dev-abcdefghijklmnop').includes('tvly-dev-abcdefghijklmnop'));
    assert.ok(!redact('https://x.test/a?api_key=sk-live-abcdef123456').includes('sk-live-abcdef123456'));
});
// ---------------------------------------------------------------------------
// #8b when the day bit and the month bit are both present, the reported period must not be wrong
// ---------------------------------------------------------------------------
test('#8b when only the daily quota is exhausted, a leftover monthly state must not make it report a monthly quota', async () => {
    const clock = { now: Date.UTC(2026, 9, 29, 12) };
    const bothAdapter = {
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
    const h = makeEngine({ adapters: [bothAdapter], now: () => clock.now });
    // Actually make one call first, so that the day exhaustion gets a key
    await h.engine.search({ query: 'x' });
    assert.equal(h.db.readExhaustedKey('tavily', 'day'), '2026-10-29', 'the day exhaustion is recorded in the current day key');
    // Then artificially leave a leftover monthly state behind (e.g. a remnant of a previous monthly exhaustion)
    h.db.writeExhaustedKey('tavily', 'month', '2026-10');
    h.db.setBits('tavily', BIT.QUOTA_MONTH); // legacy slot remnant: must be swept, never consulted
    const p = h.engine.status(false).find((x) => x.id === 'tavily');
    assert.ok(p);
    assert.equal(p.period, 'day', 'the day state must take precedence over the leftover monthly state');
    h.close();
});
// ---------------------------------------------------------------------------
// #16 concurrency: real lock-contention behaviour
// ---------------------------------------------------------------------------
test('#16 bitwise update rather than read-modify-write: two connections setting different bits in turn do not overwrite each other', () => {
    const dir = newTempDir('foragix-r2-');
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
        a.clearBits('p1', BIT.QUOTA_DAY);
        const mask = b.getProvider('p1')?.is_available ?? 0;
        assert.equal(mask & BIT.QUOTA_DAY, 0);
        assert.notEqual(mask & BIT.CREDENTIAL_MISSING, 0, 'the other bit must not be overwritten');
        a.close();
        b.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('#16 while a write transaction is held, another connection\'s write fails explicitly instead of being silently lost', () => {
    const dir = newTempDir('foragix-r2-');
    const path = join(dir, 'l.db');
    try {
        const setup = SqliteAdapter.open(path, { wal: true }, Date.now);
        applySchema(setup, DDL);
        writeSchemaVersion(setup);
        setup.ensureProvider('p1');
        setup.close();
        const holder = SqliteAdapter.open(path, { wal: true }, Date.now);
        // busyTimeout set to 0: fail immediately when the lock cannot be taken, rather than waiting forever
        const other = SqliteAdapter.open(path, { wal: true, busyTimeoutMs: 0 }, Date.now);
        holder.transaction(() => {
            holder.setBits('p1', BIT.QUOTA_DAY);
            // another connection writes while the lock is held — it must fail explicitly (SQLITE_BUSY), not silently succeed
            assert.throws(() => other.setBits('p1', BIT.CREDENTIAL_MISSING));
        });
        const mask = holder.getProvider('p1')?.is_available ?? 0;
        assert.notEqual(mask & BIT.QUOTA_DAY, 0);
        assert.equal(mask & BIT.CREDENTIAL_MISSING, 0, 'the failed write must leave no trace');
        holder.close();
        other.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
// ---------------------------------------------------------------------------
// #17 an issue message from an isolated provider must not contain a credential either
// ---------------------------------------------------------------------------
test('#17 when the user mistakenly puts a credential value into the credential name, the error message is redacted', () => {
    const yaml = `
version: 1
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: authorization
        required: true
    account: {}
`;
    // the single provider gets isolated → total wipeout → throws (this is what the design specifies)
    try {
        parseConfig(yaml, { lookup: createSchemaLookup(ADAPTERS) });
        assert.fail('should throw ConfigError');
    }
    catch (err) {
        const dump = JSON.stringify(err.issues ?? String(err));
        assert.ok(!dump.includes('authorization:'), 'the error message must not echo back anything shaped like a credential');
        assert.match(dump, /does not use the credential name|missing the credential declaration/);
    }
});
//# sourceMappingURL=review-fixes-2.test.js.map