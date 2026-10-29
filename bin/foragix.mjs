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

  try {
    const { runCli } = await import(entry);
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    fail('failed to start', 'the skill may be incomplete; reinstall it', raw.split('\n')[0]);
  }
}
