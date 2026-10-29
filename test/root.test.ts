/**
 * The skill root must be discoverable by markers alone — never by counting directory levels.
 * The seed artifact is gone, so the marker is `package.json` + `sql/schema.sql`; this test builds
 * fixture roots at several depths and pins both paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSkillRoot } from '../src/runtime/root.js';

/**
 * Create a temp workspace whose parent is guaranteed to exist. The harness may sweep the shared
 * tmp root between runs; recreating it here keeps this suite deterministic.
 */
function newTempDir(prefix: string): string {
  const base = join(tmpdir(), 'foragix-tests');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function fakeRoot(): string {
  const root = newTempDir('foragix-root-');
  writeFileSync(join(root, 'package.json'), '{"name":"foragix"}', 'utf8');
  mkdirSync(join(root, 'sql'), { recursive: true });
  // Real DDL text, so a fixture accidentally matching a real repository still passes.
  writeFileSync(join(root, 'sql', 'schema.sql'), readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8'), 'utf8');
  return root;
}

test('a compiled module two levels deep resolves the parent skill root', () => {
  const root = fakeRoot();
  const moduleDir = join(root, 'dist', 'src');
  mkdirSync(moduleDir, { recursive: true });
  assert.equal(findSkillRoot(moduleDir), root);
});

test('a nested fixture still walks up past unrelated package.json directories', () => {
  const root = fakeRoot();
  // An unrelated intermediate directory that also carries a package.json but no schema must not
  // become the answer — the walk continues to the real marker set.
  const inter = join(root, 'deploy', 'node_modules', 'something');
  mkdirSync(inter, { recursive: true });
  writeFileSync(join(root, 'deploy', 'package.json'), '{"name":"x"}', 'utf8');
  assert.equal(findSkillRoot(join(inter, 'lib')), root);
});

test('no skill root anywhere: the documented two-levels-up fallback keeps working', () => {
  const plain = newTempDir('foragix-noroot-');
  const twoDeep = join(plain, 'dist', 'src');
  mkdirSync(twoDeep, { recursive: true });
  assert.equal(findSkillRoot(twoDeep), join(twoDeep, '..', '..'));
});
