/**
 * Locate the skill's own directory.
 *
 * The same code runs from more than one depth — `dist/src/` in this layout, `bin/` next to it in
 * a runtime copy, and wherever a test fixture puts the fixture — so the root is found by walking
 * up until marker files appear rather than by counting `..` segments.
 *
 * This also survives the directory being symlinked or copied elsewhere, which is how a skill is
 * normally installed.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Files that together identify a foragix skill root. The seed is gone; the schema stayed. */
function isSkillRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'sql', 'schema.sql'));
}

/**
 * Walk up from `startDir` looking for the skill root.
 * Falls back to two levels up, which is where the root sits relative to `dist/src`.
 */
export function findSkillRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    if (isSkillRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(startDir, '..', '..');
}
