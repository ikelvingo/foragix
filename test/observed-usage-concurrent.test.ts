import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { readObserved } from '../src/state/usage.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DDL = readFileSync(join(ROOT, 'sql/schema.sql'), 'utf8');
const SQLITE = JSON.stringify(join(ROOT, 'dist/src/db/sqlite.js'));
const USAGE = JSON.stringify(join(ROOT, 'dist/src/state/usage.js'));

const INCREMENTS = 40;

function work(dbPath: string): Promise<void> {
  const script = `
    import { SqliteAdapter } from ${SQLITE};
    import { recordObserved } from ${USAGE};
    const db = SqliteAdapter.open(${JSON.stringify(dbPath)}, { wal: true }, Date.now);
    for (let i = 0; i < ${INCREMENTS}; i += 1) recordObserved(db, 'baidu', 'encyclopedia', Date.now());
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });
}

/**
 * Two processes incrementing the same endpoint counter must not lose updates. The counter is only
 * observational, but a lost increment still understates what was actually spent.
 */
test('concurrent processes never lose an observed increment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foragix-observed-'));
  const dbPath = join(dir, 'foragix.db');

  // Create the schema once, in this process, so the writers only contend on the counter row.
  const setup = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
  applySchema(setup, DDL);
  writeSchemaVersion(setup);
  setup.close();

  await Promise.all([work(dbPath), work(dbPath)]);

  const check = SqliteAdapter.open(dbPath, { wal: true }, Date.now);
  try {
    assert.equal(readObserved(check, 'baidu', 'encyclopedia')?.count, INCREMENTS * 2);
  } finally {
    check.close();
  }
});
