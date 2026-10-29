/**
 * CLI contract tests. Offline: no provider call is made, so every case is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, defaultConfigPath, EXIT_OK, EXIT_REFUSED, type CliIo } from '../src/cli.js';

const CONFIG = `
version: 1
allow_paid: false
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: TAVILY_API_KEY
        required: true
    account: {}
`;

interface Sandbox {
  readonly dir: string;
  readonly configPath: string;
  readonly dataDir: string;
  cleanup(): void;
}

function sandbox(configText: string | null = CONFIG): Sandbox {
  const dir = newTempDir('foragix-cli-');
  const configPath = join(dir, 'config.yaml');
  const dataDir = join(dir, 'data');
  if (configText !== null) writeFileSync(configPath, configText, 'utf8');
  return {
    dir,
    configPath,
    dataDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the CLI with captured output and an environment that has no provider credentials. */
async function run(argv: readonly string[], options: {
  sandbox: Sandbox;
  stdin?: string;
  stdinIsTty?: boolean;
  env?: Record<string, string>;
}): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: Partial<CliIo> = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    readStdin: async () => options.stdin ?? '',
    stdinIsTty: options.stdinIsTty ?? false,
    env: {
      HOME: options.sandbox.dir,
      TAVILY_API_KEY: '',
      ...(options.env ?? {}),
    },
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

function json(captured: Captured): Record<string, unknown> {
  const text = captured.stdout.trim();
  assert.notEqual(text, '', 'stdout must carry a JSON object');
  const lines = text.split('\n');
  assert.equal(lines.length, 1, `stdout must be exactly one JSON value, got ${lines.length} lines`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Create a temp workspace whose parent is guaranteed to exist. The harness may sweep the shared
 * tmp root between runs; recreating it here keeps this suite deterministic.
 */
function newTempDir(prefix: string): string {
  const base = join(tmpdir(), 'foragix-tests');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

test('status succeeds offline and reports the provider as unusable without credentials', async () => {
  const box = sandbox();
  try {
    const out = await run(['status', '--config', box.configPath, '--data-dir', box.dataDir], { sandbox: box });
    assert.equal(out.code, EXIT_OK);
    const body = json(out);
    assert.equal(body['ok'], true);
    const providers = body['providers'] as Array<Record<string, unknown>>;
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.['id'], 'tavily');
    assert.equal(providers[0]?.['usable'], false);
    assert.deepEqual(providers[0]?.['state'], ['credential_missing']);
  } finally {
    box.cleanup();
  }
});

test('search without credentials returns a structured refusal with exit code 2', async () => {
  const box = sandbox();
  try {
    const out = await run(['search', '--query', 'x', '--config', box.configPath, '--data-dir', box.dataDir], {
      sandbox: box,
    });
    assert.equal(out.code, EXIT_REFUSED);
    const body = json(out);
    assert.equal(body['ok'], false);
    assert.equal(body['reason'], 'no_provider_available');
    assert.equal(body['retryable'], false);
    assert.ok(Array.isArray(body['providers']));
  } finally {
    box.cleanup();
  }
});

test('a missing config file is a config_missing refusal that names the path', async () => {
  const box = sandbox(null);
  try {
    const out = await run(['status', '--config', box.configPath, '--data-dir', box.dataDir], { sandbox: box });
    assert.equal(out.code, EXIT_REFUSED);
    const body = json(out);
    assert.equal(body['code'], 'config_missing');
    assert.match(String(body['message']), /config\.yaml/);
    assert.ok(out.stderr.length > 0, 'diagnostics belong on stderr');
  } finally {
    box.cleanup();
  }
});

test('an invalid config is a config_invalid refusal carrying the issues', async () => {
  const box = sandbox('version: 1\nproviders: []\n');
  try {
    const out = await run(['status', '--config', box.configPath, '--data-dir', box.dataDir], { sandbox: box });
    assert.equal(out.code, EXIT_REFUSED);
    const body = json(out);
    assert.equal(body['code'], 'config_invalid');
    assert.ok(Array.isArray(body['issues']));
  } finally {
    box.cleanup();
  }
});

test('usage errors exit 2 with a machine-readable code', async () => {
  const box = sandbox();
  try {
    const cases: ReadonlyArray<readonly [string[], RegExp]> = [
      [['nope'], /unknown command/],
      [['search', '--config', box.configPath, '--data-dir', box.dataDir], /--query/],
      [['fetch', '--config', box.configPath, '--data-dir', box.dataDir], /--url/],
      [['status', '--bogus'], /unknown option/],
      [['status', '--max-results', '0'], /--max-results/],
    ];
    for (const [argv, pattern] of cases) {
      const out = await run(argv, { sandbox: box });
      assert.equal(out.code, EXIT_REFUSED, `expected exit 2 for ${argv.join(' ')}`);
      const body = json(out);
      assert.equal(body['code'], 'usage_error');
      assert.match(String(body['message']), pattern);
    }
  } finally {
    box.cleanup();
  }
});

test('--input-json accepts the request on stdin', async () => {
  const box = sandbox();
  try {
    const out = await run(['--input-json', '--config', box.configPath, '--data-dir', box.dataDir], {
      sandbox: box,
      stdin: JSON.stringify({ command: 'status' }),
    });
    assert.equal(out.code, EXIT_OK);
    const body = json(out);
    assert.equal(body['ok'], true);
    assert.ok(Array.isArray(body['providers']));
  } finally {
    box.cleanup();
  }
});

test('--input-json carries search parameters, including quotes and newlines', async () => {
  const box = sandbox();
  try {
    const out = await run(['--input-json', '--config', box.configPath, '--data-dir', box.dataDir], {
      sandbox: box,
      stdin: JSON.stringify({ command: 'search', query: 'a "quoted"\nline' }),
    });
    // No credentials, so this is a refusal — but it must be a parsed request, not a usage error.
    assert.equal(out.code, EXIT_REFUSED);
    const body = json(out);
    assert.equal(body['ok'], false);
    assert.equal(body['reason'], 'no_provider_available');
  } finally {
    box.cleanup();
  }
});

test('--input-json refuses an interactive terminal instead of blocking', async () => {
  const box = sandbox();
  try {
    const out = await run(['--input-json', '--config', box.configPath, '--data-dir', box.dataDir], {
      sandbox: box,
      stdinIsTty: true,
    });
    assert.equal(out.code, EXIT_REFUSED);
    assert.equal(json(out)['code'], 'usage_error');
  } finally {
    box.cleanup();
  }
});

test('--input-json rejects malformed stdin', async () => {
  const box = sandbox();
  try {
    for (const stdin of ['not json', '[]', '{"command": 42}']) {
      const out = await run(['--input-json', '--config', box.configPath, '--data-dir', box.dataDir], {
        sandbox: box,
        stdin,
      });
      assert.equal(out.code, EXIT_REFUSED, `stdin ${stdin}`);
      assert.equal(json(out)['code'], 'usage_error');
    }
  } finally {
    box.cleanup();
  }
});

test('explicit flags win over environment variables for config discovery', async () => {
  const box = sandbox();
  try {
    const out = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: () => {},
      stderr: () => {},
      env: { HOME: box.dir, FORAGIX_CONFIG: join(box.dir, 'does-not-exist.yaml'), TAVILY_API_KEY: '' },
      stdinIsTty: false,
    });
    assert.equal(out, EXIT_OK, 'the explicit --config must win over FORAGIX_CONFIG');
  } finally {
    box.cleanup();
  }
});

test('--version emits JSON and --help emits text (the only non-JSON stdout case)', async () => {
  const box = sandbox();
  try {
    const v = await run(['--version'], { sandbox: box });
    assert.equal(v.code, EXIT_OK);
    assert.equal(json(v)['name'], 'foragix');

    const h = await run(['--help'], { sandbox: box });
    assert.equal(h.code, EXIT_OK);
    assert.match(h.stdout, /Usage:/);

    const both = await run(['--help', '--version'], { sandbox: box });
    assert.equal(both.code, EXIT_REFUSED, 'the combination is ambiguous, so it must not silently pick one');
    assert.equal(json(both)['code'], 'usage_error');
  } finally {
    box.cleanup();
  }
});

/** A stand-in instance whose behaviour the test controls. */
function fakeApp(overrides: Partial<Record<'search' | 'fetch' | 'status' | 'close', () => unknown>>): unknown {
  return {
    config: { providers: [], isolated: [{ id: 'broken', issues: [] }] },
    search: async () => ({}),
    fetch: async () => ({}),
    status: () => [],
    close: () => {},
    ...overrides,
  };
}

test('a failing close() still yields exactly one JSON document and a clean exit code', async () => {
  const box = sandbox();
  let stdout = '';
  let stderr = '';
  try {
    const out = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () =>
        fakeApp({
          close: () => {
            throw new Error('close blew up');
          },
        }) as never,
    });

    // "exactly one JSON value" is asserted by parsing a single line.
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(out, EXIT_OK, 'a close failure must not change a successful result');
    assert.equal(body['ok'], true);
    assert.match(stderr, /failed to close/);
  } finally {
    box.cleanup();
  }
});

test('a throwing status() reports a safe internal error without echoing the exception message', async () => {
  const box = sandbox();
  let stdout = '';
  let stderr = '';
  try {
    const out = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () =>
        fakeApp({
          status: () => {
            throw new Error('token=tvly-SECRET-abc at /home/u/private');
          },
        }) as never,
    });

    assert.equal(out, 1);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(body['code'], 'internal_error');
    assert.equal(body['message'], 'internal error');
    // The raw message must not reach stdout ...
    assert.ok(!stdout.includes('tvly-SECRET-abc'), 'the machine contract must not echo the exception message');
    // ... nor stderr, unless the caller explicitly opted into debug output.
    assert.ok(!stderr.includes('tvly-SECRET-abc'), 'stderr must not leak the exception message by default');
  } finally {
    box.cleanup();
  }
});

test('FORAGIX_DEBUG=1 adds a redacted diagnostic on stderr only', async () => {
  const box = sandbox();
  let stderr = '';
  try {
    await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: () => {},
      stderr: (t) => {
        stderr += t;
      },
      env: { HOME: box.dir, TAVILY_API_KEY: '', FORAGIX_DEBUG: '1' },
      stdinIsTty: false,
      createForagix: () =>
        fakeApp({
          status: () => {
            throw new Error('something went wrong internally');
          },
        }) as never,
    });
    assert.match(stderr, /debug:/);
  } finally {
    box.cleanup();
  }
});

test('status exposes providers isolated by an invalid provider-level entry', async () => {
  const box = sandbox();
  let stdout = '';
  let stderr = '';
  try {
    const out = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () => fakeApp({}) as never,
    });
    assert.equal(out, EXIT_OK);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.deepEqual(body['isolated'], [{ id: 'broken', issues: [] }], 'isolated entries must stay visible');
  } finally {
    box.cleanup();
  }
});

test('--max-results rejects values outside the safe integer range and the documented ceiling', async () => {
  const box = sandbox();
  try {
    for (const bad of ['1e100', '999', '1.5', '0', '-1', 'abc']) {
      const out = await run(['search', '--query', 'x', '--max-results', bad, '--config', box.configPath], {
        sandbox: box,
      });
      assert.equal(out.code, EXIT_REFUSED, `--max-results ${bad} must be rejected`);
      assert.equal(json(out)['code'], 'usage_error');
    }
    const big = await run(
      ['--input-json', '--config', box.configPath, '--data-dir', box.dataDir],
      { sandbox: box, stdin: JSON.stringify({ command: 'status', maxResults: 1e100 }) },
    );
    assert.equal(big.code, EXIT_REFUSED, 'an unsafe integer via stdin must be rejected too');
  } finally {
    box.cleanup();
  }
});

test('explicit flags win over the same field supplied on stdin', async () => {
  const box = sandbox();
  try {
    // stdin says search without a query; the flag supplies it, so this must not be a usage error.
    const out = await run(['--input-json', '--query', 'from the flag', '--config', box.configPath, '--data-dir', box.dataDir], {
      sandbox: box,
      stdin: JSON.stringify({ command: 'search' }),
    });
    assert.equal(out.code, EXIT_REFUSED);
    assert.equal(json(out)['reason'], 'no_provider_available', 'the flag-supplied query must be used');
  } finally {
    box.cleanup();
  }
});

test('a repeated option takes the last value rather than silently combining them', async () => {
  const box = sandbox();
  try {
    const out = await run(['status', '--config', '/nope/first.yaml', '--config', box.configPath], { sandbox: box });
    assert.equal(out.code, EXIT_OK, 'the last --config must win');
  } finally {
    box.cleanup();
  }
});


test('an unwritable stdout never makes runCli throw', async () => {
  const box = sandbox();
  try {
    const code = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: () => {
        throw new Error('EPIPE: broken pipe');
      },
      stderr: () => {},
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () => fakeApp({}) as never,
    });
    assert.equal(code, 1, 'a lost result cannot be reported as success');
  } finally {
    box.cleanup();
  }
});

test('an unwritable stderr never makes runCli throw', async () => {
  const box = sandbox();
  try {
    let stdout = '';
    const code = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {
        throw new Error('EPIPE: broken pipe');
      },
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () =>
        fakeApp({
          status: () => {
            throw new Error('boom');
          },
        }) as never,
    });
    assert.equal(code, 1);
    assert.equal((JSON.parse(stdout.trim()) as Record<string, unknown>)['code'], 'internal_error');
  } finally {
    box.cleanup();
  }
});

test('a payload that cannot be serialised still yields exactly one JSON document', async () => {
  const box = sandbox();
  try {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    let stdout = '';
    const code = await runCli(['status', '--config', box.configPath, '--data-dir', box.dataDir], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      env: { HOME: box.dir, TAVILY_API_KEY: '' },
      stdinIsTty: false,
      createForagix: () => fakeApp({ status: () => circular }) as never,
    });
    assert.equal(code, 1);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(body['code'], 'internal_error');
  } finally {
    box.cleanup();
  }
});

test('no config anywhere runs on the built-in defaults', async () => {
  const box = sandbox(null);
  try {
    const out = await run(['status'], { sandbox: box, env: { HOME: box.dir, TAVILY_API_KEY: '' } });
    assert.equal(out.code, EXIT_OK, 'the first run needs no config file');
    const providers = (json(out)['providers'] as Array<Record<string, unknown>>).map((p) => p['id']);
    assert.deepEqual(providers, ['tavily', 'exa'], 'every implemented adapter is enabled by default');
  } finally {
    box.cleanup();
  }
});

test('the default config path sits in ~/.foragix and is read when present', async () => {
  const box = sandbox(null);
  try {
    const home = join(box.dir, 'home');
    mkdirSync(join(home, '.foragix'), { recursive: true });
    writeFileSync(join(home, '.foragix', 'config.yaml'), 'version: 1\nproviders:\n  - id: exa\n', 'utf8');
    const out = await run(['status'], { sandbox: box, env: { HOME: home, EXA_API_KEY: '' } });
    assert.equal(out.code, EXIT_OK);
    const providers = (json(out)['providers'] as Array<Record<string, unknown>>).map((p) => p['id']);
    assert.deepEqual(providers, ['exa'], 'a config at the default path must be picked up');
    assert.equal(defaultConfigPath({ HOME: home }), join(home, '.foragix', 'config.yaml'));
  } finally {
    box.cleanup();
  }
});

test('an explicitly named config must exist and wins over the built-in defaults', async () => {
  const box = sandbox(null);
  try {
    const missing = join(box.dir, 'absent.yaml');
    const refused = await run(['status', '--config', missing], { sandbox: box, env: { HOME: box.dir } });
    assert.equal(refused.code, EXIT_REFUSED, 'an explicitly named file that is missing is an error');
    assert.equal((json(refused) as Record<string, unknown>)['code'], 'config_missing');

    const mine = join(box.dir, 'mine.yaml');
    writeFileSync(mine, 'version: 1\nproviders:\n  - id: exa\n', 'utf8');
    const out = await run(['status', '--config', mine], { sandbox: box, env: { HOME: box.dir, EXA_API_KEY: '' } });
    assert.equal(out.code, EXIT_OK);
    const providers = (json(out)['providers'] as Array<Record<string, unknown>>).map((p) => p['id']);
    assert.deepEqual(providers, ['exa'], 'the file given with --config must win');
  } finally {
    box.cleanup();
  }
});

test('state lives in ~/.foragix by default and --data-dir moves it', async () => {
  const box = sandbox(null);
  const home = join(box.dir, 'home');
  mkdirSync(home, { recursive: true });
  const xdgData = join(box.dir, 'xdg-should-stay-empty');
  try {
    const code = await runCli(['status'], {
      stdout: () => {},
      stderr: () => {},
      env: { HOME: home, XDG_DATA_HOME: xdgData, TAVILY_API_KEY: '' },
      stdinIsTty: false,
    });
    assert.equal(code, EXIT_OK);
    assert.ok(existsSync(join(home, '.foragix', 'foragix.db')), 'the database belongs in ~/.foragix/foragix.db');
    const leaked = existsSync(xdgData) ? readdirSync(xdgData) : [];
    assert.deepEqual(leaked, [], 'no XDG data directory may be created');

    const alt = join(box.dir, 'alt-state');
    const moved = await runCli(['status', '--data-dir', alt], {
      stdout: () => {},
      stderr: () => {},
      env: { HOME: home, TAVILY_API_KEY: '' },
      stdinIsTty: false,
    });
    assert.equal(moved, EXIT_OK);
    assert.ok(existsSync(join(alt, 'foragix.db')), '--data-dir moves the state');
  } finally {
    box.cleanup();
  }
});
