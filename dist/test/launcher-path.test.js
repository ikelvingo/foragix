import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('launcher loads its entry from a path containing URL-special characters', () => {
    const root = mkdtempSync(join(tmpdir(), 'foragix # 空格 '));
    try {
        mkdirSync(join(root, 'bin'));
        mkdirSync(join(root, 'dist', 'src'), { recursive: true });
        copyFileSync(new URL('../../bin/foragix.mjs', import.meta.url), join(root, 'bin', 'foragix.mjs'));
        writeFileSync(join(root, 'package.json'), '{"type":"module"}');
        writeFileSync(join(root, 'dist', 'src', 'cli.js'), 'export async function runCli() { console.log("entry loaded"); return 0; }');
        const result = spawnSync(process.execPath, [join(root, 'bin', 'foragix.mjs')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'entry loaded');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=launcher-path.test.js.map