#!/usr/bin/env node
/**
 * Executable entry for the skill.
 *
 * The code lives in the compiled output `dist/`, shipped with the skill together with its one
 * runtime dependency. Running it needs nothing installed beyond Node itself.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'src', 'cli.js');

/** Emit the contract-shaped failure and stop. Detail goes to stderr, never to stdout. */
function fail(message, hint, detail) {
  // This runs when the process is already in trouble, so writing must not throw either:
  // a closed stdout pipe would otherwise replace the diagnostic with a stack trace.
  try {
    const body = { ok: false, code: 'internal_error', message, ...(hint === undefined ? {} : { hint }) };
    process.stdout.write(`${JSON.stringify(body)}\n`);
  } catch {
    // Nothing else can be reported.
  }
  try {
    process.stderr.write(`foragix: ${message}${detail === undefined ? '' : `: ${detail}`}\n`);
  } catch {
    // Nothing else can be reported.
  }
  process.exitCode = 1;
}

if (!existsSync(entry)) {
  fail('the skill is incomplete', 'dist/ is missing; reinstall the skill', entry);
} else {
  // Node prints an experimental notice for node:sqlite on every run. Drop exactly that one;
  // every other warning still reaches stderr. Installed here because it is process-wide.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && w.message.startsWith('SQLite is an experimental feature')) return;
    try {
      process.stderr.write(`${w.name}: ${w.message}\n`);
    } catch {
      // Nothing else can be reported.
    }
  });

  let selfHealed = false;
  try {
    const { runCli } = await import(entry);
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (err) {
    // The single runtime dependency (`yaml`) missing from an installed copy is the one
    // recoverable start-up failure: bootstrap it once in place, then start again. The env
    // flag bounds the retry at exactly one attempt per process tree — the spawned rerun
    // carries it, so a bootstrap that stays broken can never recurse into fresh children.
    if (
      process.env['FORAGIX_SELF_HEAL'] !== '1' &&
      /Cannot find package ['"]yaml['"]/.test(String(err))
    ) {
      try {
        // A network failure stays the honest failure the fail() branch reports; nothing is hidden.
        // ESM caches a failed resolution for this run, so the retry happens in a fresh process.
        const { spawnSync, execSync } = await import('node:child_process');
        process.stderr.write('foragix: installing the single runtime dependency (yaml)…\n');
        execSync('npm install --omit=dev --no-audit --no-fund', {
          cwd: join(here, '..'),
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        const rerun = spawnSync(process.execPath, [join(here, 'foragix.mjs'), ...process.argv.slice(2)], {
          stdio: 'inherit',
          cwd: join(here, '..'),
          env: { ...process.env, FORAGIX_SELF_HEAL: '1' },
        });
        process.exitCode = rerun.status ?? 1;
        selfHealed = true;
      } catch {
        /* fall through to the start-up failure below */
      }
    }
    if (!selfHealed) {
      const raw = err instanceof Error ? err.message : String(err);
      fail('failed to start', 'the skill may be incomplete; reinstall it', raw.split('\n')[0]);
    }
  }
}
