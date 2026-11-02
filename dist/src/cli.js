/**
 * Command-line entry point: the product surface for agents that can run scripts.
 *
 * Contract:
 *  - stdout carries exactly one JSON object (the only exception is `--help`, which prints text);
 *  - diagnostics go to stderr only;
 *  - exit code 0 = success, 2 = expected refusal or configuration problem, 1 = internal error.
 *
 * Nothing here depends on a particular agent, protocol or vendor.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config/types.js';
import { agentEnvFiles } from './credentials/load.js';
import { homedir } from 'node:os';
import { describeError, redact } from './errors/redact.js';
import { createForagix } from './index.js';
export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_ERROR = 1;
const COMMANDS = ['search', 'fetch', 'status'];
class UsageError extends Error {
}
const FLAGS_WITH_VALUE = new Set([
    '--config',
    '--data-dir',
    '--credentials',
    '--query',
    '--url',
    '--max-results',
]);
const FLAGS_BOOLEAN = new Set(['--problems', '--input-json', '--help', '--version']);
function parseArgs(argv) {
    const values = new Map();
    const booleans = new Set();
    let command = null;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            const name = eq === -1 ? arg : arg.slice(0, eq);
            if (FLAGS_BOOLEAN.has(name)) {
                if (eq !== -1)
                    throw new UsageError(`${name} does not take a value`);
                booleans.add(name);
                continue;
            }
            if (!FLAGS_WITH_VALUE.has(name))
                throw new UsageError(`unknown option: ${name}`);
            if (eq !== -1) {
                values.set(name, arg.slice(eq + 1));
                continue;
            }
            const next = argv[i + 1];
            if (next === undefined)
                throw new UsageError(`${name} requires a value`);
            values.set(name, next);
            i += 1;
            continue;
        }
        if (command !== null)
            throw new UsageError(`unexpected argument: ${arg}`);
        command = arg;
    }
    if (command !== null && !COMMANDS.includes(command)) {
        throw new UsageError(`unknown command: ${command} (expected: ${COMMANDS.join(', ')})`);
    }
    const maxRaw = values.get('--max-results');
    let maxResults = null;
    if (maxRaw !== undefined) {
        const n = Number(maxRaw);
        if (!Number.isSafeInteger(n) || n < 1 || n > 100) {
            throw new UsageError('--max-results must be an integer between 1 and 100');
        }
        maxResults = n;
    }
    return {
        command: command,
        query: values.get('--query') ?? null,
        url: values.get('--url') ?? null,
        maxResults,
        problems: booleans.has('--problems'),
        configPath: values.get('--config') ?? null,
        dataDir: values.get('--data-dir') ?? null,
        credentialFilePath: values.get('--credentials') ?? null,
        inputJson: booleans.has('--input-json'),
        help: booleans.has('--help'),
        version: booleans.has('--version'),
    };
}
function fromStdin(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new UsageError('--input-json: stdin is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new UsageError('--input-json: stdin must be a JSON object');
    }
    const obj = parsed;
    const out = {};
    if (obj['command'] !== undefined) {
        if (typeof obj['command'] !== 'string')
            throw new UsageError('--input-json: command must be a string');
        out.command = obj['command'];
    }
    if (obj['query'] !== undefined) {
        if (typeof obj['query'] !== 'string')
            throw new UsageError('--input-json: query must be a string');
        out.query = obj['query'];
    }
    if (obj['url'] !== undefined) {
        if (typeof obj['url'] !== 'string')
            throw new UsageError('--input-json: url must be a string');
        out.url = obj['url'];
    }
    if (obj['maxResults'] !== undefined) {
        const n = obj['maxResults'];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 100) {
            throw new UsageError('--input-json: maxResults must be an integer between 1 and 100');
        }
        out.maxResults = n;
    }
    return out;
}
/** The user data/config home for foragix (mmx-cli's ~/.mmx/ precedent). */
function dataHome(env) {
    const home = env['HOME'] ?? homedir();
    return join(home, '.foragix');
}
/** The optional config file. Its absence is normal and enables nothing special. */
export function defaultConfigPath(env) {
    return join(dataHome(env), 'config.yaml');
}
/**
 * State lives in the skill directory, next to the config. There is deliberately **no** silent
 * fallback to a hidden user path: if the skill directory cannot hold state, the caller is told
 * and can pick a location with `--data-dir`. State must never appear somewhere nobody expects.
 */
function resolveDataDir(io, requested) {
    if (requested !== null)
        return requested;
    const inSkill = dataHome(io.env);
    try {
        mkdirSync(inSkill, { recursive: true });
        // Prove the directory really accepts writes: permissions on the directory say nothing about
        // an existing database file, its -wal/-shm sidecars, or a read-only mount.
        const probe = join(inSkill, '.write-probe');
        writeFileSync(probe, '');
        rmSync(probe, { force: true });
        return inSkill;
    }
    catch {
        const err = new Error(`${inSkill} is not writable`);
        writeErr(io, `foragix: ${err.message}\n`);
        emitError(io, 'data_dir_unwritable', err.message, {
            hint: 'pass --data-dir <path>, or make the skill directory writable',
        });
        return null;
    }
}
const HELP = `foragix — Search and Fetch for agents, across multiple providers.

Usage:
  foragix search --query <text> [--max-results <n>]
  foragix fetch  --url <url>
  foragix status [--problems]

Options:
  --config <path>        Config file (default: ~/.foragix/config.yaml; the built-in defaults
                         apply when it is absent)
  --data-dir <path>      Writable data directory (default: ~/.foragix)
  --credentials <path>   Credential file (replaces the .env search entirely)
  --input-json           Read the request as JSON from stdin
  --problems             status only: list abnormal providers only
  --help                 Print this text
  --version              Print the version as JSON

Contract:
  stdout is exactly one JSON object; diagnostics go to stderr.
  Exit code 0 = success, 2 = expected refusal or configuration problem, 1 = internal error.
`;
/**
 * Write one JSON document. Returns false when stdout itself is unwritable — a closed pipe
 * (EPIPE) must not turn into an exception, because there is nothing left to report to.
 * Serialisation happens before the write, so a circular payload still raises normally.
 */
function emitJson(io, value) {
    const text = `${JSON.stringify(value)}\n`;
    try {
        io.stdout(text);
        return true;
    }
    catch {
        return false;
    }
}
/** Write plain text (help). Same contract as emitJson. */
function writeOut(io, text) {
    try {
        io.stdout(text);
        return true;
    }
    catch {
        return false;
    }
}
/** Diagnostics must never throw: a broken stderr cannot become an exception. */
function writeErr(io, text) {
    try {
        io.stderr(text);
    }
    catch {
        // Nothing useful remains to be done with this message.
    }
}
function emitError(io, code, message, extra = {}) {
    emitJson(io, { ok: false, code, message, ...extra });
}
function version(io) {
    let name = 'foragix';
    let ver = io.env['npm_package_version'] ?? null;
    if (ver === null) {
        try {
            const here = dirname(fileURLToPath(import.meta.url));
            // `import.meta.url` points at dist/src/cli.js; the package root is two levels up.
            const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
            name = pkg.name ?? name;
            ver = pkg.version ?? null;
        }
        catch {
            // Version is cosmetic; a missing package.json must not fail the command.
        }
    }
    return emitJson(io, { ok: true, name, version: ver }) ? EXIT_OK : EXIT_ERROR;
}
/**
 * Run one CLI invocation and return the process exit code.
 * Never throws: every failure becomes a JSON object on stdout plus a stderr diagnostic.
 */
export async function runCli(argv, ioOverrides = {}) {
    const io = {
        stdout: (t) => process.stdout.write(t),
        stderr: (t) => process.stderr.write(t),
        readStdin: async () => {
            const chunks = [];
            for await (const chunk of process.stdin)
                chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        },
        env: process.env,
        stdinIsTty: process.stdin.isTTY === true,
        ...ioOverrides,
    };
    try {
        const args = parseArgs(argv);
        if (args.help && args.version)
            throw new UsageError('--help and --version are mutually exclusive');
        if (args.help) {
            return writeOut(io, HELP) ? EXIT_OK : EXIT_ERROR;
        }
        if (args.version)
            return version(io);
        // `--input-json` supplies request fields; explicit flags still win.
        let request = {};
        if (args.inputJson) {
            if (io.stdinIsTty)
                throw new UsageError('--input-json: stdin is a terminal; pipe a JSON object instead');
            request = fromStdin(await io.readStdin());
        }
        const command = args.command ?? request.command ?? null;
        if (command === null)
            throw new UsageError(`missing command (expected: ${COMMANDS.join(', ')})`);
        if (!COMMANDS.includes(command)) {
            throw new UsageError(`unknown command: ${command} (expected: ${COMMANDS.join(', ')})`);
        }
        const query = args.query ?? request.query ?? null;
        const url = args.url ?? request.url ?? null;
        const maxResults = args.maxResults ?? request.maxResults ?? null;
        // The config is an optional override layer. Every default — provider list, priorities,
        // allow_paid gate — is built into the code, so a missing file is the normal first-run state.
        const requestedConfig = args.configPath ?? io.env['FORAGIX_CONFIG'] ?? null;
        let configPath = requestedConfig ?? defaultConfigPath(io.env);
        if (!existsSync(configPath)) {
            if (requestedConfig !== null) {
                // Only an explicitly named file can be "missing": that is an error worth reporting.
                writeErr(io, `foragix: config not found: ${configPath}\n`);
                emitError(io, 'config_missing', `config file not found: ${configPath}`, {
                    hint: 'omit --config to run on the built-in defaults',
                });
                return EXIT_REFUSED;
            }
            // The default config file and the built-in defaults carry identical values: an absent
            // file starts the skill; only a file the caller named must exist.
            configPath = null;
        }
        const dataDir = resolveDataDir(io, args.dataDir ?? io.env['FORAGIX_DATA_DIR'] ?? null);
        if (dataDir === null)
            return EXIT_REFUSED;
        // The host is a variable, never a constant: the default host is the current Linux user's
        // environment (plain process variables). A working-directory `.env` beats it; a host may
        // declare itself with FORAGIX_HOST_ENV and its layer wins; `--credentials` replaces both.
        const explicitCredentials = args.credentialFilePath ?? io.env['FORAGIX_CREDENTIALS'] ?? null;
        const credentialFilePaths = agentEnvFiles(io.env, io.cwd ?? process.cwd(), explicitCredentials);
        if (command === 'search' && (query === null || query.trim() === '')) {
            throw new UsageError('search requires --query <text>');
        }
        if (command === 'fetch' && (url === null || url.trim() === '')) {
            throw new UsageError('fetch requires --url <url>');
        }
        const build = io.createForagix ?? createForagix;
        const app = build({
            configPath,
            dataDir,
            credentialFilePath: explicitCredentials,
            credentialFilePaths,
            env: io.env,
        });
        // The payload is produced before the instance is closed. A close() failure is a diagnostic,
        // never a second JSON document: stdout must carry exactly one value on every path.
        let payload;
        let exitCode = EXIT_ERROR;
        try {
            if (command === 'search') {
                const result = await app.search({
                    query: query,
                    ...(maxResults === null ? {} : { maxResults }),
                });
                payload = result;
                exitCode = result.ok ? EXIT_OK : EXIT_REFUSED;
            }
            else if (command === 'fetch') {
                const result = await app.fetch({ url: url });
                payload = result;
                exitCode = result.ok ? EXIT_OK : EXIT_REFUSED;
            }
            else {
                payload = {
                    ok: true,
                    providers: app.status({ onlyProblems: args.problems }),
                    isolated: app.config.isolated,
                };
                exitCode = EXIT_OK;
            }
        }
        finally {
            try {
                app.close();
            }
            catch (closeErr) {
                writeErr(io, `foragix: warning: failed to close: ${describeError(closeErr)}\n`);
            }
        }
        return emitJson(io, payload) ? exitCode : EXIT_ERROR;
    }
    catch (err) {
        if (err instanceof UsageError) {
            writeErr(io, `foragix: ${err.message}\n`);
            emitError(io, 'usage_error', err.message, { hint: 'run with --help' });
            return EXIT_REFUSED;
        }
        if (err instanceof ConfigError) {
            writeErr(io, `foragix: configuration is invalid\n`);
            emitError(io, 'config_invalid', 'configuration is invalid', {
                // Issue paths and messages are built from the config file, so they can carry
                // user-supplied text; redact before they reach the machine-readable output.
                issues: err.issues.map((i) => ({
                    path: redact(i.path, 100),
                    level: i.level,
                    message: redact(i.message, 200),
                })),
            });
            return EXIT_REFUSED;
        }
        // An arbitrary exception message may contain credentials or internal paths, so it never
        // enters the machine contract. describeError() is closed-set by construction.
        const detail = describeError(err);
        writeErr(io, `foragix: internal error (${detail})\n`);
        if (io.env['FORAGIX_DEBUG'] === '1' && err instanceof Error) {
            writeErr(io, `foragix: debug: ${redact(err.message, 300)}\n`);
        }
        emitError(io, 'internal_error', 'internal error', { detail });
        return EXIT_ERROR;
    }
}
//# sourceMappingURL=cli.js.map