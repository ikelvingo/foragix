/**
 * Node's `node:sqlite` is still experimental and prints an `ExperimentalWarning` once per
 * process. That notice is noise on stderr for a command whose stdout is a machine contract.
 *
 * This helper drops exactly that notice and forwards every other warning unchanged. It
 * rewrites a process-global listener, so call it once, from a process entry point.
 */
const SQLITE_NOTICE_PREFIX = 'SQLite is an experimental feature';

export function suppressSqliteExperimentalWarning(write: (text: string) => void = (t) => {
  process.stderr.write(t);
}): void {
  process.removeAllListeners('warning');
  process.on('warning', (w: Error) => {
    if (w.name === 'ExperimentalWarning' && w.message.startsWith(SQLITE_NOTICE_PREFIX)) return;
    write(`${w.name}: ${w.message}\n`);
  });
}
