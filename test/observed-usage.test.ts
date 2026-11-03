import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { recordObserved, readObserved } from '../src/state/usage.js';

const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');

function db(): SqliteAdapter {
  const handle = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
  applySchema(handle, DDL);
  writeSchemaVersion(handle);
  return handle;
}

test('observed endpoint usage accumulates without touching provider quota rows', () => {
  const handle = db();
  try {
    recordObserved(handle, 'baidu', 'encyclopedia', 1_700_000_000_000);
    recordObserved(handle, 'baidu', 'encyclopedia', 1_700_000_001_000);
    const seen = readObserved(handle, 'baidu', 'encyclopedia');
    assert.equal(seen?.count, 2);
    assert.equal(seen?.first_at, 1_700_000_000_000);
    assert.equal(handle.getProvider('baidu'), null, 'no provider row is created or modified');
    assert.equal(handle.readExhaustedKey('baidu', 'day'), null, 'no quota key is written');
  } finally { handle.close(); }
});

test('observed usage is namespaced per endpoint and per provider', () => {
  const handle = db();
  try {
    recordObserved(handle, 'baidu', 'encyclopedia', 1_700_000_000_000);
    recordObserved(handle, 'baidu', 'video', 1_700_000_000_000);
    recordObserved(handle, 'zhihu', 'content', 1_700_000_000_000);
    assert.equal(readObserved(handle, 'baidu', 'encyclopedia')?.count, 1);
    assert.equal(readObserved(handle, 'baidu', 'video')?.count, 1);
    assert.equal(readObserved(handle, 'zhihu', 'content')?.count, 1);
    assert.equal(readObserved(handle, 'baidu', 'search'), null);
  } finally { handle.close(); }
});
