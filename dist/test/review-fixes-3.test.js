/**
 * Regression tests for the findings of the third review round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, checkDdlHash, checkSchemaVersion, ddlHash, parseDdlColumns, probeSchema, writeSchemaVersion, SCHEMA_VERSION, SCHEMA_DDL_HASH_KEY, } from '../src/db/schema.js';
import { ensureDatabase } from '../src/runtime/db.js';
import { parseConfig } from '../src/config/load.js';
import { ConfigError } from '../src/config/types.js';
import { createSchemaLookup, ADAPTERS } from '../src/providers/registry.js';
import { describeError, redact } from '../src/errors/redact.js';
import { BIT, PERSISTENT_BIT_MASK, PERIOD_IRRELEVANT_BIT_MASK, decodeReasons } from '../src/db/bits.js';
import { dayKey, monthKey } from '../src/db/period.js';
const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
function tmpDb() {
    const dir = newTempDir('foragix-r3-');
    return { dir, path: join(dir, 't.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// ---------------------------------------------------------------------------
// #5 (third round) name / code are not a closed set either
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
test('#5 a maliciously constructed name / code is blocked by the allowlist and is not echoed verbatim', () => {
    const err = new Error('x');
    err.name = 'secret-value';
    err.code = 'another-secret';
    assert.equal(describeError(err), 'Error', 'name is not in the standard error-name allowlist → normalized to Error');
    const err2 = new Error('x');
    err2.code = 'sk-live-abcdef123456';
    assert.equal(describeError(err2), 'Error', 'code does not match the SCREAMING_SNAKE shape → discarded');
});
test('#5 standard error names and error codes are preserved (the troubleshooting information stays usable)', () => {
    const err = new Error('connect failed');
    err.name = 'TypeError';
    err.code = 'ECONNREFUSED';
    assert.equal(describeError(err), 'TypeError: ECONNREFUSED');
});
test('#5 error names common across languages / runtimes are recognized as well', () => {
    for (const name of ['AbortError', 'TimeoutError', 'SyntaxError', 'DOMException']) {
        const err = new Error('x');
        err.name = name;
        assert.equal(describeError(err), name);
    }
});
// ---------------------------------------------------------------------------
// #5 (third round) a YAML parse error must not echo the offending input
// ---------------------------------------------------------------------------
test('#5 a YAML parse error reports only the position, never the source text', () => {
    // Deliberately break the YAML and put a credential-looking value in the text
    const bad = 'version: 1\nproviders:\n  - id: tavily\n   api_key: sk-live-abcdef123456\n';
    try {
        parseConfig(bad, { lookup: createSchemaLookup(ADAPTERS) });
        assert.fail('a ConfigError should have been thrown');
    }
    catch (err) {
        assert.ok(err instanceof ConfigError);
        const dump = JSON.stringify(err.issues);
        assert.ok(!dump.includes('sk-live-abcdef123456'), `the parse error must not echo the source text: ${dump}`);
        assert.match(dump, /YAML parsing failed/);
    }
});
// ---------------------------------------------------------------------------
// Newly introduced issue: quotaPeriod=none deserves its own bit
// ---------------------------------------------------------------------------
test('QUOTA_UNKNOWN is a persistent bit, and a period boundary must not clear it', () => {
    assert.ok((PERSISTENT_BIT_MASK & BIT.QUOTA_UNKNOWN) !== 0, 'it must belong to the persistent bits');
    assert.ok((PERIOD_IRRELEVANT_BIT_MASK & BIT.QUOTA_UNKNOWN) !== 0, 'a period boundary must not clear it');
    assert.deepEqual(decodeReasons(BIT.QUOTA_UNKNOWN), ['quota_exhausted_unknown']);
});
test('QUOTA_UNKNOWN is distinguishable from the month bit and the two never get confused', () => {
    assert.notEqual(BIT.QUOTA_UNKNOWN, BIT.QUOTA_MONTH);
    assert.deepEqual(decodeReasons(BIT.QUOTA_MONTH | BIT.QUOTA_UNKNOWN), [
        'quota_exhausted_month',
        'quota_exhausted_unknown',
    ]);
});
test('quotaPeriod=both with no period in the classification falls into QUOTA_UNKNOWN instead of picking the month bit', async () => {
    const { Engine } = await import('../src/engine.js');
    const { loadCredentials } = await import('../src/credentials/load.js');
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
        // The classification gives **no** period — with `both` the error itself
        // cannot tell us which of the two quotas ran out
        search: async () => ({
            ok: false,
            classification: { kind: 'quota', period: null, evidence: 'exhausted' },
        }),
    };
    const t = tmpDb();
    try {
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
        const config = parseConfig(yaml, { lookup: createSchemaLookup([bothAdapter]) });
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        writeSchemaVersion(db);
        const engine = new Engine({
            db,
            config,
            credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
            adapters: new Map([[bothAdapter.id, bothAdapter]]),
            fetchImpl: (async () => new Response('', { status: 200 })),
        });
        engine.bootstrap();
        await engine.search({ query: 'x' });
        const mask = db.getProvider('tavily')?.is_available ?? 0;
        assert.notEqual(mask & BIT.QUOTA_UNKNOWN, 0, 'both + an unknown period must fall into QUOTA_UNKNOWN');
        assert.equal(mask & BIT.QUOTA_MONTH, 0, 'the month bit must not be picked');
        assert.equal(mask & BIT.QUOTA_DAY, 0, 'the day bit must not be picked either');
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test('quotaPeriod explicitly day/month still falls back to the declared period', async () => {
    const { Engine } = await import('../src/engine.js');
    const { loadCredentials } = await import('../src/credentials/load.js');
    for (const declared of ['day', 'month']) {
        const adapter = {
            id: 'tavily',
            capabilities: ['search'],
            schema: { id: 'tavily', requiresCredentials: true, credentialNames: ['TAVILY_API_KEY'], accountOptions: {} },
            init: () => ({
                version: 1,
                canCharge: false,
                quotaPeriod: declared,
                dayLimit: declared === 'day' ? 100 : null,
                monthLimit: declared === 'month' ? 3000 : null,
                unit: 'requests',
                resetTimezone: 'UTC',
            }),
            search: async () => ({
                ok: false,
                classification: { kind: 'quota', period: null, evidence: 'exhausted' },
            }),
        };
        const t = tmpDb();
        try {
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
            const config = parseConfig(yaml, { lookup: createSchemaLookup([adapter]) });
            const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
            applySchema(db, DDL);
            writeSchemaVersion(db);
            const engine = new Engine({
                db,
                config,
                credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
                adapters: new Map([[adapter.id, adapter]]),
                fetchImpl: (async () => new Response('', { status: 200 })),
            });
            engine.bootstrap();
            await engine.search({ query: 'x' });
            const mask = db.getProvider('tavily')?.is_available ?? 0;
            assert.equal(db.readExhaustedKey('tavily', declared), declared === 'day' ? dayKey('UTC', Date.now()) : monthKey('UTC', Date.now()), `quotaPeriod=${declared} must fall back to its matching exhausted-period key`);
            assert.equal(mask & BIT.QUOTA_UNKNOWN, 0, 'a clear declaration must not land on the unknown bit');
            db.close();
        }
        finally {
            t.cleanup();
        }
    }
});
// ---------------------------------------------------------------------------
// blocker: a legacy database missing columns must be caught at load time
// ---------------------------------------------------------------------------
test('probeSchema detects missing columns', () => {
    const t = tmpDb();
    try {
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        // Simulate an older DDL: no quota_period / pool_id
        db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE provider_state (
        provider_id TEXT PRIMARY KEY, is_enable INTEGER NOT NULL DEFAULT 1,
        is_available INTEGER NOT NULL DEFAULT 0, retry_after INTEGER,
        transient_streak INTEGER NOT NULL DEFAULT 0, day_key TEXT, month_key TEXT,
        day_limit INTEGER, month_limit INTEGER, unit TEXT, reset_timezone TEXT,
        can_charge INTEGER, day_used INTEGER NOT NULL DEFAULT 0,
        month_used INTEGER NOT NULL DEFAULT 0, static_version INTEGER,
        account_digest TEXT, needs_migration INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL,
        at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
      );
    `);
        const probe = probeSchema(db, DDL);
        assert.equal(probe.ok, false, 'the missing columns must be detected');
        assert.match(probe.message ?? '', /provider_state/);
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test('probeSchema passes for the current DDL', () => {
    const t = tmpDb();
    try {
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        assert.equal(probeSchema(db, DDL).ok, true);
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test("probeSchema's column list is parsed from the DDL, not a hand-written second definition", () => {
    const parsed = parseDdlColumns(DDL);
    assert.ok(parsed.has('provider_state'));
    const cols = parsed.get('provider_state') ?? [];
    for (const expected of ['provider_id', 'quota_period', 'pool_id', 'credential_fingerprint', 'needs_migration']) {
        assert.ok(cols.includes(expected), `column ${expected} should have been parsed, got: ${cols.join(',')}`);
    }
    // Table-level constraints must not be mistaken for columns
    assert.ok(!cols.includes('PRIMARY'), 'table-level constraints must not leak into the column list');
});
test('a legacy database (no fingerprint, older version) is rejected during ensureDatabase, not when some SQL later blows up', () => {
    const t = tmpDb();
    try {
        // It must sit at the **exact** path of the runtime copy:
        // ensureDatabase uses <dataDir>/foragix.db
        const runtimePath = join(t.dir, 'foragix.db');
        const old = SqliteAdapter.open(runtimePath, { wal: false }, Date.now);
        old.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE provider_state (provider_id TEXT PRIMARY KEY, is_enable INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE provider_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL);
    `);
        old.writeMeta('schema_version', '1'); // old version, and **no** schema_ddl_hash
        old.close();
        assert.throws(() => ensureDatabase({
            dataDir: t.dir,
            ddl: DDL,
        }), /schema validation failed|structure probe failed/, 'the legacy database must be rejected explicitly');
    }
    finally {
        t.cleanup();
    }
});
test('a legacy database with the same version number is still rejected by the structure probe', () => {
    const t = tmpDb();
    try {
        const runtimePath = join(t.dir, 'foragix.db');
        const old = SqliteAdapter.open(runtimePath, { wal: false }, Date.now);
        old.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE provider_state (provider_id TEXT PRIMARY KEY, is_enable INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE provider_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL);
    `);
        // The version number is **deliberately** the current one, and there is no
        // fingerprint — this is exactly the gap the review pointed out
        old.writeMeta('schema_version', String(SCHEMA_VERSION));
        old.close();
        assert.throws(() => ensureDatabase({ dataDir: t.dir, ddl: DDL }), /structure probe failed/, 'even with a matching version number, the structure probe must find the missing columns');
    }
    finally {
        t.cleanup();
    }
});
test('a mismatched version number produces an explicit message', () => {
    const t = tmpDb();
    try {
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        db.writeMeta('schema_version', '1');
        const check = checkSchemaVersion(db);
        assert.equal(check.ok, false);
        assert.match(check.message ?? '', /lower than|migration/);
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test('a mismatched DDL fingerprint is detected (the database was created by an older release)', () => {
    const t = tmpDb();
    try {
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        db.writeMeta(SCHEMA_DDL_HASH_KEY, ddlHash('CREATE TABLE totally_different (x);'));
        const check = checkDdlHash(db, DDL);
        assert.equal(check.ok, false);
        assert.match(check.message ?? '', /DDL changed/);
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test('a matching DDL fingerprint passes; a database without a fingerprint is skipped (legacy compatibility)', () => {
    const t = tmpDb();
    try {
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        db.writeMeta(SCHEMA_DDL_HASH_KEY, ddlHash(DDL));
        assert.equal(checkDdlHash(db, DDL).ok, true);
        db.writeMeta(SCHEMA_DDL_HASH_KEY, ''); // an empty string means "absent"
        // Delete the row outright to simulate a genuine legacy database
        db.exec("DELETE FROM schema_meta WHERE key = 'schema_ddl_hash'");
        assert.equal(checkDdlHash(db, DDL).ok, true, 'the check is skipped when there is no fingerprint record');
        db.close();
    }
    finally {
        t.cleanup();
    }
});
test('the DDL fingerprint is insensitive to pure formatting changes (whitespace normalization)', () => {
    assert.equal(ddlHash('CREATE TABLE a (x);'), ddlHash('CREATE   TABLE a\n(x);'));
    assert.notEqual(ddlHash('CREATE TABLE a (x);'), ddlHash('CREATE TABLE a (y);'));
});
test('the DDL fingerprint ignores comment edits, so a comment-only change cannot reject existing databases', () => {
    const base = [
        'CREATE TABLE t (',
        '  -- leading comment',
        '  a TEXT,  -- trailing comment',
        '  b TEXT',
        ');',
    ].join('\n');
    const baseline = ddlHash(base);
    assert.equal(ddlHash(`${base}\n-- extra line\n`), baseline, 'added comment line');
    assert.equal(ddlHash(base.replace('-- leading comment', '-- rewritten')), baseline, 'rewritten comment');
    assert.equal(ddlHash(base.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')), baseline, 'removed comment line');
    assert.equal(ddlHash(base.split('\n').map((l) => l.replace(/\s*--.*$/, '')).filter((l) => l.trim() !== '').join('\n')), baseline, 'removed all comments');
    // A real schema change must still be detected.
    assert.notEqual(ddlHash(base.replace('b TEXT', 'b INTEGER')), baseline);
});
test('the DDL fingerprint ignores block comments as well as line comments', () => {
    const bare = 'CREATE TABLE t (\n a TEXT,\n b TEXT);';
    const baseline = ddlHash(bare);
    const variants = [
        ['inline block comment', 'CREATE TABLE t (/* note */\n a TEXT,\n b TEXT);'],
        ['multi-line block comment', 'CREATE TABLE t (\n/* multi\n line */\n a TEXT,\n b TEXT);'],
        ['block plus line comment', 'CREATE TABLE t (\n/* x */ -- y\n a TEXT,\n b TEXT);'],
        ['rewritten block comment', 'CREATE TABLE t (/* completely different text */\n a TEXT,\n b TEXT);'],
    ];
    for (const [label, variant] of variants) {
        assert.equal(ddlHash(variant), baseline, `block comment must not change the fingerprint: ${label}`);
    }
});
test('the DDL fingerprint keeps quoted content significant, including a comment-looking sequence inside it', () => {
    assert.notEqual(ddlHash("CREATE TABLE t (x TEXT DEFAULT 'a  b');"), ddlHash("CREATE TABLE t (x TEXT DEFAULT 'a b');"), 'quoted whitespace is preserved');
    assert.notEqual(ddlHash("CREATE TABLE t (x TEXT DEFAULT 'a--b');"), ddlHash("CREATE TABLE t (x TEXT DEFAULT 'ab');"), 'a `--` inside quotes is data, not a comment');
    assert.notEqual(ddlHash("CREATE TABLE t (x TEXT DEFAULT 'a/*b*/c');"), ddlHash("CREATE TABLE t (x TEXT DEFAULT 'ac');"), 'a `/* */` inside quotes is data, not a comment');
});
test('a comment sequence inside a quoted identifier is data, not a comment', () => {
    // Double quotes, backticks and square brackets all quote identifiers in SQLite. A `--` inside one
    // must not be read as a line comment, or the rest of the DDL would be silently truncated.
    const pairs = [
        ['double quotes', 'CREATE TABLE "a--b" (x TEXT);', 'CREATE TABLE "ab" (x TEXT);'],
        ['backticks', 'CREATE TABLE `a--b` (x TEXT);', 'CREATE TABLE `ab` (x TEXT);'],
        ['square brackets', 'CREATE TABLE [a--b] (x TEXT);', 'CREATE TABLE [ab] (x TEXT);'],
        ['double quotes with /*', 'CREATE TABLE "a/*b*/c" (x TEXT);', 'CREATE TABLE "ac" (x TEXT);'],
    ];
    for (const [label, withComment, without] of pairs) {
        assert.notEqual(ddlHash(withComment), ddlHash(without), `identifier quoting must be honoured: ${label}`);
    }
    // The truncation symptom: an identifier containing `--` must not collapse to a prefix of the DDL.
    assert.notEqual(ddlHash('CREATE TABLE "a--b" (x TEXT);'), ddlHash('CREATE TABLE "a'), 'the quoted identifier must not truncate the remaining DDL');
});
test('first-run creation from the DDL writes both the version and the fingerprint', () => {
    const t = tmpDb();
    try {
        const handle = ensureDatabase({ dataDir: t.dir, ddl: DDL });
        assert.equal(handle.created, true);
        assert.equal(handle.db.readMeta(SCHEMA_DDL_HASH_KEY), ddlHash(DDL), 'first-run creation must write the fingerprint too');
        assert.equal(handle.db.readMeta('schema_version'), String(SCHEMA_VERSION));
        handle.db.close();
    }
    finally {
        t.cleanup();
    }
});
// ---------------------------------------------------------------------------
// Open question: a write failure on the failure path must also fail closed
// ---------------------------------------------------------------------------
test('a failed classification whose state cannot be written also returns state_store_error', async () => {
    const { Engine } = await import('../src/engine.js');
    const { loadCredentials } = await import('../src/credentials/load.js');
    const { classifyResponse } = await import('../src/errors/classify.js');
    void classifyResponse;
    const t = tmpDb();
    try {
        const adapters = ADAPTERS;
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
        const config = parseConfig(yaml, { lookup: createSchemaLookup(adapters) });
        const db = SqliteAdapter.open(t.path, { wal: false }, Date.now);
        applySchema(db, DDL);
        writeSchemaVersion(db);
        // Make the adapter return a failure, and close the database just before
        // the failed state is written
        const adapter = {
            ...adapters.find((a) => a.id === 'tavily'),
            search: async () => {
                const response = { ok: false, classification: { kind: 'transient', evidence: 'HTTP 503' } };
                db.close();
                return response;
            },
        };
        const engine = new Engine({
            db,
            config,
            credentials: loadCredentials({ env: { TAVILY_API_KEY: 'k' } }),
            adapters: new Map([[adapter.id, adapter]]),
            fetchImpl: (async () => new Response('', { status: 200 })),
        });
        engine.bootstrap();
        const result = await engine.search({ query: 'x' });
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.reason, 'state_store_error', 'when the failure state cannot be written it must fail closed too');
        }
    }
    finally {
        t.cleanup();
    }
});
// ---------------------------------------------------------------------------
// The version number must not be written twice — once in the source, once in the build script
// ---------------------------------------------------------------------------
test('the seed artifact chain is gone: no seed dir, no build:seed script, no seed fanfare', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['build:seed'], undefined, 'no seed build step may remain');
    assert.ok(!pkg.files.includes('seed'), 'the package must not ship a seed');
    assert.ok(!existsSync(new URL('../../scripts/build-seed.mjs', import.meta.url)), 'no build-seed script');
    assert.ok(!existsSync(new URL('../../seed', import.meta.url)), 'no seed directory');
});
test("redact's positioning is documented in the source as \"best-effort\"", () => {
    const src = readFileSync(new URL('../../src/errors/redact.ts', import.meta.url), 'utf8');
    assert.match(src, /best-effort, not a security guarantee/);
});
//# sourceMappingURL=review-fixes-3.test.js.map