/**
 * Cross-process concurrency: several CLI-shaped processes sharing one SQLite database.
 *
 * In-process tests cannot cover this. Each CLI invocation is its own process, so lock waits,
 * transaction boundaries and bit updates must hold up when separate processes interleave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { BIT } from '../src/db/bits.js';
const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
const SQLITE_URL = fileURLToPath(new URL('../src/db/sqlite.js', import.meta.url));
/** One worker: repeatedly set a bit, count usage, clear the bit, each inside one transaction. */
const WORKER = (dbPath, rounds) => `
import { SqliteAdapter } from ${JSON.stringify(SQLITE_URL)};
const db = SqliteAdapter.open(${JSON.stringify(dbPath)}, { wal: true, busyTimeoutMs: 15000 }, Date.now);
try {
  for (let i = 0; i < ${rounds}; i += 1) {
    db.transaction(() => {
      db.setBits('p1', ${BIT.QUOTA_DAY});
      db.addUsed('p1', 'day', 1, null);
      db.clearBits('p1', ${BIT.QUOTA_DAY});
    });
  }
} finally {
  db.close();
}
`;
function runWorker(dbPath, rounds) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER(dbPath, rounds)], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('close', (code) => resolve({ code, stderr }));
    });
}
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
test('separate processes can write the same database concurrently without losing updates', async () => {
    const dir = newTempDir('foragix-xproc-');
    const dbPath = join(dir, 'foragix.db');
    const workers = 4;
    const rounds = 25;
    try {
        const setup = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        applySchema(setup, DDL);
        writeSchemaVersion(setup, undefined, DDL);
        setup.ensureProvider('p1');
        setup.close();
        const results = await Promise.all(Array.from({ length: workers }, () => runWorker(dbPath, rounds)));
        for (const [index, result] of results.entries()) {
            assert.equal(result.code, 0, `worker ${index} failed: ${result.stderr}`);
        }
        const check = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        const row = check.getProvider('p1');
        check.close();
        // Every increment must have landed: a lost update would show up here.
        assert.equal(row?.day_used, workers * rounds, 'no usage increment may be lost across processes');
        // Every set was paired with a clear, so the bitmask must be back to zero.
        assert.equal(row?.is_available, 0, 'bit set/clear pairs must cancel out across processes');
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('a second process waits for a held write transaction instead of failing outright', async () => {
    const dir = newTempDir('foragix-xproc-');
    const dbPath = join(dir, 'foragix.db');
    const openedFile = join(dir, 'opened');
    const goFile = join(dir, 'go');
    const elapsedFile = join(dir, 'elapsed');
    let holder = null;
    let child = null;
    try {
        const setup = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        applySchema(setup, DDL);
        writeSchemaVersion(setup, undefined, DDL);
        setup.ensureProvider('p1');
        setup.close();
        holder = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        // Ordering is load-bearing: the child must finish opening BEFORE the parent takes the write
        // lock, and must attempt its write only afterwards. Signalling in the other order deadlocks.
        //
        // Every signal is a FILE, not stdout: some sandboxes swallow a child's piped stdout entirely
        // (the child runs and exits 0 while the parent reads nothing), which made this test fail for
        // a reason that had nothing to do with SQLite.
        const childScript = `
import { existsSync, writeFileSync } from 'node:fs';
import { SqliteAdapter } from ${JSON.stringify(SQLITE_URL)};
const db = SqliteAdapter.open(${JSON.stringify(dbPath)}, { wal: true, busyTimeoutMs: 8000 }, Date.now);
writeFileSync(${JSON.stringify(openedFile)}, '');
const deadline = Date.now() + 25000;
while (!existsSync(${JSON.stringify(goFile)})) {
  if (Date.now() > deadline) {
    writeFileSync(${JSON.stringify(join(dir, 'child-timeout'))}, 'sentinel never appeared');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const startedAt = Date.now();
try {
  db.setBits('p1', ${BIT.CREDENTIAL_MISSING});
} finally {
  writeFileSync(${JSON.stringify(elapsedFile)}, String(Date.now() - startedAt));
  db.close();
}
`;
        const proc = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
            stdio: 'ignore',
        });
        child = proc;
        let exited = false;
        let exitCode = null;
        void new Promise((resolve) => {
            proc.on('close', (code) => {
                exited = true;
                exitCode = code;
                resolve();
            });
        });
        const why = () => {
            const marker = join(dir, 'child-timeout');
            return existsSync(marker)
                ? `child timed out: ${readFileSync(marker, 'utf8')}`
                : `child state: opened=${existsSync(openedFile)} go=${existsSync(goFile)} elapsed=${existsSync(elapsedFile)} exited=${exited} code=${exitCode ?? 'none'}`;
        };
        const waitForFile = (file, label) => new Promise((resolve, reject) => {
            const deadline = Date.now() + 25000;
            const tick = () => {
                if (existsSync(file))
                    return resolve();
                if (exited)
                    return reject(new Error(`child exited before ${label}; ${why()}`));
                if (Date.now() > deadline)
                    return reject(new Error(`timed out waiting for ${label}; ${why()}`));
                setTimeout(tick, 10);
            };
            tick();
        });
        // The child holds the database open and is idle. Now take the write lock ...
        await waitForFile(openedFile, 'the child to open the database');
        holder.exec('BEGIN IMMEDIATE');
        holder.setBits('p1', BIT.QUOTA_DAY);
        // ... release it to write, and hold the lock a while longer ...
        writeFileSync(goFile, '');
        const holdMs = 250;
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        // ... then commit. A writer that did not wait would already have failed with SQLITE_BUSY.
        holder.exec('COMMIT');
        await waitForFile(elapsedFile, 'the child to finish its write');
        const deadline = Date.now() + 25000;
        while (!exited && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(exited, `child did not exit; ${why()}`);
        assert.equal(exitCode, 0, `the waiting writer must succeed rather than fail on the lock; ${why()}`);
        // The elapsed time is the evidence that it actually waited on the lock rather than
        // slipping through before the parent committed.
        const elapsed = Number(readFileSync(elapsedFile, 'utf8'));
        assert.ok(elapsed >= holdMs - 50, `the writer must have waited for the lock, measured ${elapsed}ms`);
        const mask = holder.getProvider('p1')?.is_available ?? 0;
        assert.notEqual(mask & BIT.QUOTA_DAY, 0, 'the holder write must persist');
        assert.notEqual(mask & BIT.CREDENTIAL_MISSING, 0, 'the waiting writer must have applied its bit');
    }
    finally {
        // A failed assertion must not leave the child process behind.
        try {
            child?.kill();
        }
        catch {
            // Already gone.
        }
        try {
            holder?.close();
        }
        catch {
            // Closing on a failed assertion must not mask the original failure.
        }
        rmSync(dir, { recursive: true, force: true });
    }
});
test('a second connection joins an existing WAL database instead of blocking in open()', async () => {
    const dir = newTempDir('foragix-xproc-');
    const dbPath = join(dir, 'foragix.db');
    let holder = null;
    try {
        const setup = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        applySchema(setup, DDL);
        writeSchemaVersion(setup, undefined, DDL);
        setup.ensureProvider('p1');
        holder = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
        // The regression this guards: re-promoting an already-WAL file takes a write lock, which on
        // some filesystems is not bounded by busy_timeout, so a second process hung inside open().
        const startedAt = Date.now();
        const result = await runWorker(dbPath, 1);
        assert.equal(result.code, 0, `opening an existing WAL database must not block: ${result.stderr}`);
        assert.ok(Date.now() - startedAt < 20_000, 'the second connection must not wait on a lock just to open');
    }
    finally {
        try {
            holder?.close();
        }
        catch {
            // Closing on a failed assertion must not mask the original failure.
        }
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=cross-process.test.js.map