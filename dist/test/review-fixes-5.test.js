/**
 * Regression tests for the findings of the fifth review round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, ddlHash, normalizeDdl, parseDdlColumns, writeSchemaVersion } from '../src/db/schema.js';
import { Engine } from '../src/engine.js';
import { parseConfig } from '../src/config/load.js';
import { loadCredentials } from '../src/credentials/load.js';
import { createSchemaLookup } from '../src/providers/registry.js';
import { BIT } from '../src/db/bits.js';
import { dayKey, monthKey } from '../src/db/period.js';
import { describeError } from '../src/errors/redact.js';
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
/** Build an adapter that only implements search and returns the given failure classification. */
function adapterReturning(classification, quotaPeriod) {
    return {
        id: 'tavily',
        capabilities: ['search'],
        schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
        init: () => ({
            version: 1,
            canCharge: false,
            quotaPeriod,
            dayLimit: quotaPeriod === 'day' || quotaPeriod === 'both' ? 100 : null,
            monthLimit: quotaPeriod === 'month' || quotaPeriod === 'both' ? 3000 : null,
            unit: 'requests',
            resetTimezone: 'UTC',
        }),
        search: async () => ({ ok: false, classification }),
    };
}
function runOnce(adapter, onDiagnostic) {
    const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const config = parseConfig(YAML_TAVILY, { lookup: createSchemaLookup([adapter]) });
    const engine = new Engine({
        db,
        config,
        credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
        adapters: new Map([[adapter.id, adapter]]),
        fetchImpl: (async () => new Response('', { status: 200 })),
        ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    });
    engine.bootstrap();
    return { db, engine };
}
// ---------------------------------------------------------------------------
// blocker: evidence constructed directly by an adapter must not be persisted (without relying on any regex)
// ---------------------------------------------------------------------------
test('a custom string matching no token shape must not enter the log or diagnostics either', async () => {
    // This string deliberately contains none of the known shapes (sk-/Bearer/authorization:, etc.),
    // so the generic redaction cannot do anything about it — this is exactly the bypass path the review pointed out
    const customSecret = 'zzqq77xx-custom-thing-9911';
    const adapter = adapterReturning({ kind: 'credential_rejected', evidence: customSecret }, 'month');
    const seen = [];
    const h = runOnce(adapter, (_e, d) => seen.push(d));
    const result = await h.engine.search({ query: 'x' });
    const logs = h.db.recentChanges('tavily');
    const dump = JSON.stringify({ logs, seen, result });
    assert.ok(!dump.includes(customSecret), `the custom string must not be persisted: ${dump.slice(0, 400)}`);
    // But the structural label must be there, otherwise observability is lost
    assert.ok(logs.some((l) => l.detail === 'credential_rejected'), `the log should carry a structural label, actual: ${JSON.stringify(logs)}`);
    h.db.close();
});
test('the quota log records only a structural label and no evidence', async () => {
    const customSecret = 'plain-text-that-looks-harmless-42';
    const adapter = adapterReturning({ kind: 'quota', period: 'month', evidence: customSecret }, 'month');
    const h = runOnce(adapter);
    await h.engine.search({ query: 'x' });
    const logs = h.db.recentChanges('tavily');
    const dump = JSON.stringify(logs);
    assert.ok(!dump.includes(customSecret), `must not be persisted: ${dump}`);
    assert.ok(logs.some((l) => (l.detail ?? '').includes('quota_exhausted_month')), `a structural label should be recorded: ${dump}`);
    h.db.close();
});
test('the our_problem diagnostic callback only gets a structural label, and that label really exists', async () => {
    const customSecret = 'another-plain-string-77';
    const adapter = adapterReturning({ kind: 'our_problem', evidence: customSecret }, 'month');
    const seen = [];
    const h = runOnce(adapter, (_e, d) => seen.push(d));
    await h.engine.search({ query: 'x' });
    const dump = JSON.stringify(seen);
    assert.ok(!dump.includes(customSecret), `the diagnostic must not contain free text: ${dump}`);
    // At the same time verify that **observability is still there**: safety and troubleshooting must hold together
    assert.ok(seen.some((d) => d['label'] === 'our_problem'), `the diagnostic should contain the structural label our_problem, actual: ${dump}`);
    assert.ok(h.db.recentChanges('tavily').some((l) => l.detail === 'our_problem'), 'the change log should also carry a structural label');
    h.db.close();
});
test('the evidence of transient / rate_limited_short is likewise not persisted', async () => {
    const customSecret = 'transient-plain-string-88';
    for (const kind of ['transient', 'rate_limited_short']) {
        const adapter = {
            ...adapterReturning({ kind: 'our_problem', evidence: 'x' }, 'month'),
            search: async () => ({ ok: false, classification: { kind, evidence: customSecret, cooldownMs: 5000 } }),
        };
        const seen = [];
        const h = runOnce(adapter, (_e, d) => seen.push(d));
        await h.engine.search({ query: 'x' });
        const dump = JSON.stringify({ logs: h.db.recentChanges('tavily'), seen });
        assert.ok(!dump.includes(customSecret), `the evidence of ${kind} must not be persisted: ${dump}`);
        assert.ok(h.db.recentChanges('tavily').some((l) => (l.detail ?? '').includes(kind)), `${kind} should leave a structural label`);
        h.db.close();
    }
});
// ---------------------------------------------------------------------------
// Period matrix: four declarations × with/without an explicit period
// ---------------------------------------------------------------------------
test('period matrix: when a single period is declared, fall back to the declaration', async () => {
    const cases = ['day', 'month'];
    for (const declared of cases) {
        const h = runOnce(adapterReturning({ kind: 'quota', period: null, evidence: 'x' }, declared));
        await h.engine.search({ query: 'x' });
        const storedKey = h.db.readExhaustedKey('tavily', declared);
        assert.equal(storedKey, declared === 'day' ? dayKey('UTC', Date.now()) : monthKey('UTC', Date.now()), `quotaPeriod=${declared} should fall back to the corresponding exhausted-period key`);
        assert.equal((h.db.getProvider('tavily')?.is_available ?? 0) & BIT.QUOTA_UNKNOWN, 0);
        h.db.close();
    }
});
test('period matrix: both + an explicit period → use the explicit period', async () => {
    for (const explicit of ['day', 'month']) {
        const h = runOnce(adapterReturning({ kind: 'quota', period: explicit, evidence: 'x' }, 'both'));
        await h.engine.search({ query: 'x' });
        const storedKey = h.db.readExhaustedKey('tavily', explicit);
        assert.equal(storedKey, explicit === 'day' ? dayKey('UTC', Date.now()) : monthKey('UTC', Date.now()), `both + period=${explicit} should apply the explicit period`);
        assert.equal((h.db.getProvider('tavily')?.is_available ?? 0) & BIT.QUOTA_UNKNOWN, 0);
        h.db.close();
    }
});
test('period matrix: both + no explicit period → QUOTA_UNKNOWN', async () => {
    const h = runOnce(adapterReturning({ kind: 'quota', period: null, evidence: 'x' }, 'both'));
    await h.engine.search({ query: 'x' });
    const mask = h.db.getProvider('tavily')?.is_available ?? 0;
    assert.notEqual(mask & BIT.QUOTA_UNKNOWN, 0);
    assert.equal(mask & (BIT.QUOTA_DAY | BIT.QUOTA_MONTH), 0);
    h.db.close();
});
test('period matrix: with none, the contradictory explicit period is ignored and it lands on QUOTA_UNKNOWN', async () => {
    // The adapter declares "there is no determinable reset period" while also giving period: 'day' — that is self-contradictory.
    // The declared semantics win — otherwise the state bit (the day bit) and the report (period: null) would disagree.
    const h = runOnce(adapterReturning({ kind: 'quota', period: 'day', evidence: 'x' }, 'none'));
    await h.engine.search({ query: 'x' });
    const mask = h.db.getProvider('tavily')?.is_available ?? 0;
    assert.notEqual(mask & BIT.QUOTA_UNKNOWN, 0, 'it should land on the unknown bit');
    assert.equal(mask & BIT.QUOTA_DAY, 0, 'the day bit must not be set');
    // The report must agree with the state bit
    const report = h.engine.status(false).find((p) => p.id === 'tavily');
    assert.ok(report);
    assert.equal(report.period, null, 'the report and the state bit must agree');
    assert.equal(report.resets_at, null);
    h.db.close();
});
test('period matrix: none + no explicit period → QUOTA_UNKNOWN', async () => {
    const h = runOnce(adapterReturning({ kind: 'quota', period: null, evidence: 'x' }, 'none'));
    await h.engine.search({ query: 'x' });
    assert.notEqual((h.db.getProvider('tavily')?.is_available ?? 0) & BIT.QUOTA_UNKNOWN, 0);
    h.db.close();
});
// ---------------------------------------------------------------------------
// normalizeDdl: escaped single quotes
// ---------------------------------------------------------------------------
test('normalizeDdl correctly recognizes SQL escaped single quotes', () => {
    // `'a''  b'` is a single string, the two spaces inside it must be preserved
    const a = "CREATE TABLE t (x TEXT DEFAULT 'a''  b');";
    const b = "CREATE TABLE t (x TEXT DEFAULT 'a'' b');";
    assert.notEqual(ddlHash(a), ddlHash(b), 'different whitespace inside the string → the fingerprints must differ');
    // Whitespace **outside** the string should still be collapsed
    assert.equal(ddlHash('CREATE TABLE t (x TEXT);'), ddlHash('CREATE  TABLE   t\n  (x TEXT);'));
});
test('normalizeDdl preserves whitespace inside strings and collapses whitespace outside them', () => {
    assert.equal(normalizeDdl("DEFAULT 'a  b'"), "DEFAULT 'a  b'");
    assert.equal(normalizeDdl('a    b'), 'a b');
});
// ---------------------------------------------------------------------------
// parseDdlColumns: table-level constraints and commas inside parentheses
// ---------------------------------------------------------------------------
test('parseDdlColumns does not treat table-level constraints as columns', () => {
    const synthetic = `
    CREATE TABLE IF NOT EXISTS demo (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      a        TEXT    NOT NULL,
      b        TEXT,
      PRIMARY KEY (a, b),
      FOREIGN KEY (a) REFERENCES other (id),
      UNIQUE (a, b),
      CONSTRAINT ck CHECK (length(a) > 0),
      CHECK (b IS NOT NULL)
    );
  `;
    const cols = parseDdlColumns(synthetic).get('demo');
    assert.deepEqual(cols, ['id', 'a', 'b'], `actually parsed: ${JSON.stringify(cols)}`);
});
test('parseDdlColumns splits on top-level commas; a comma inside CHECK does not split a column', () => {
    const synthetic = `
    CREATE TABLE IF NOT EXISTS demo2 (
      x INTEGER CHECK (x IN (1, 2, 3)),
      y TEXT
    );
  `;
    const cols = parseDdlColumns(synthetic).get('demo2');
    assert.deepEqual(cols, ['x', 'y'], `actually parsed: ${JSON.stringify(cols)}`);
});
test('parseDdlColumns does not drop columns when a string contains a closing parenthesis', () => {
    const synthetic = `
    CREATE TABLE IF NOT EXISTS demo4 (
      x TEXT DEFAULT ')',
      y TEXT
    );
  `;
    const cols = parseDdlColumns(synthetic).get('demo4');
    assert.deepEqual(cols, ['x', 'y'], `the ')' inside the string must not end the table body early: ${JSON.stringify(cols)}`);
});
test('parseDdlColumns yields an empty table when no table can be parsed at all (probeSchema reports it explicitly instead of silently letting it pass)', () => {
    const cols = parseDdlColumns('CREATE TABLE demo3 AS SELECT 1;');
    assert.equal(cols.size, 0, 'AS SELECT is not supported → empty result');
});
// ---------------------------------------------------------------------------
// Closed set of error codes: the samples named by the review
// ---------------------------------------------------------------------------
test('all error code samples named by the review are discarded', () => {
    for (const code of ['PASSWORD', 'SECRET_KEY', 'API_TOKEN', 'API_KEY', 'sk-live-abcdef123456']) {
        const err = new Error('x');
        err.code = code;
        assert.equal(describeError(err), 'Error', `${code} should be discarded`);
    }
});
test('enumerated error codes are still preserved', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ABORT_ERR', 'SQLITE_BUSY', 'ERR_INVALID_ARG_TYPE']) {
        const err = new Error('x');
        err.code = code;
        assert.equal(describeError(err), `Error: ${code}`);
    }
});
//# sourceMappingURL=review-fixes-5.test.js.map