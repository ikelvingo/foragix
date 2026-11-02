/**
 * The host is a VARIABLE, never a constant: no agent gets hard-coded as the host. The default
 * host is the current Linux user's environment; a host may *declare itself* with
 * `FORAGIX_HOST_ENV=/path/to/.env`, and the working directory's `.env` rounds out the local layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnvFiles, loadCredentials } from '../src/credentials/load.js';
/**
 * Create a temp workspace whose parent is guaranteed to exist. The harness may sweep the shared
 * tmp root between runs; recreating it here keeps this suite deterministic.
 */
function newTempDir(prefix) {
    const base = join(tmpdir(), 'foragix-tests');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
}
test('the default host is the user environment: no agent file is ever probed', () => {
    const cwd = newTempDir('foragix-host-');
    try {
        assert.deepEqual(agentEnvFiles({ HOME: cwd }, join(cwd, 'work')), [], 'the user environment needs no file');
        // A hermes/openclaw directory must carry zero weight anywhere in the search.
        assert.deepEqual(agentEnvFiles({ HOME: cwd, OPENCLAW_SHELL: '1' }, cwd), []);
    }
    finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
test('the working directory .env joins the local layer', () => {
    const cwd = newTempDir('foragix-host-');
    try {
        writeFileSync(join(cwd, '.env'), 'EXA_API_KEY=k-from-cwd\n', 'utf8');
        const files = agentEnvFiles({ HOME: cwd }, cwd);
        assert.deepEqual(files, [join(cwd, '.env')]);
    }
    finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
test('a host declares itself with FORAGIX_HOST_ENV, and its layer wins', () => {
    const base = newTempDir('foragix-host-');
    try {
        const hostEnv = join(base, 'host.env');
        writeFileSync(hostEnv, 'TAVILY_API_KEY=k-host\n', 'utf8');
        const cwd = join(base, 'work');
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(cwd, '.env'), 'TAVILY_API_KEY=k-cwd\n', 'utf8');
        const files = agentEnvFiles({ HOME: base, FORAGIX_HOST_ENV: hostEnv }, cwd);
        assert.deepEqual(files, [join(cwd, '.env'), hostEnv], 'cwd first, declared host last: the later entry wins');
        const view = loadCredentials({ env: { TAVILY_API_KEY: 'k-from-env' }, filePaths: files });
        assert.equal(view.get('TAVILY_API_KEY'), 'k-host', 'the declared host layer beats cwd and the environment');
        assert.equal(view.describe(['TAVILY_API_KEY'])[0]?.source, 'file');
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
test('files beat the inherited environment (load_dotenv override=True semantics)', () => {
    const base = newTempDir('foragix-host-');
    try {
        const envFile = join(base, 'host.env');
        writeFileSync(envFile, 'TAVILY_API_KEY=k-file\n', 'utf8');
        const view = loadCredentials({
            env: { TAVILY_API_KEY: 'k-from-env' },
            filePaths: [envFile],
        });
        assert.equal(view.get('TAVILY_API_KEY'), 'k-file');
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
test('an explicitly named file replaces the discovery entirely', () => {
    const base = newTempDir('foragix-host-');
    try {
        const explicit = join(base, 'mine.env');
        writeFileSync(explicit, 'X=1\n', 'utf8');
        assert.deepEqual(agentEnvFiles({ HOME: base }, base, explicit), [explicit]);
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
//# sourceMappingURL=agent-env.test.js.map