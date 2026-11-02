/**
 * Credential resolution and fingerprints.
 * Values stay in memory only — never written to SQLite, logs, error messages or files.
 * A `.env` outside the skill wins over the environment; both are independent sources.
 * The fingerprint hashes (name, value, source); only that hash is stored.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Parse `.env`-style text. Only `KEY=VALUE` is supported; blank lines and `#` comments are ignored; values may be wrapped in a matching pair of quotes. */
export function parseEnvFile(text) {
    const out = new Map();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2) {
            const first = value[0];
            const last = value[value.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                value = value.slice(1, -1);
            }
        }
        if (key !== '' && value !== '')
            out.set(key, value);
    }
    return out;
}
export function loadCredentials(options = {}) {
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? ((p) => readFileSync(p, 'utf8'));
    const fromEnv = new Map();
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value !== '')
            fromEnv.set(key, value);
    }
    const fromFile = new Map();
    // A caller-named file replaces the layered search entirely; otherwise the passed layers are
    // read in order, and the later file wins, so the most specific layer is read last.
    const files = options.filePath ? [options.filePath] : (options.filePaths ?? []);
    for (const path of files) {
        let text;
        try {
            text = readFile(path);
        }
        catch (err) {
            // A missing or unreadable file is not fatal: the environment may already provide every
            // credential. A read failure is reported to stderr with the path only, never the content.
            const code = err.code;
            if (code !== 'ENOENT') {
                process.stderr.write(`foragix: unable to read credential file (${code ?? 'unknown'}): ${path}\n`);
            }
            text = '';
        }
        for (const [k, v] of parseEnvFile(text))
            fromFile.set(k, v);
    }
    const resolved = new Map();
    const names = new Set([...fromEnv.keys(), ...fromFile.keys()]);
    // Files win over the environment, matching load_dotenv(override=True): the `.env` layers are
    // the "current agent's environment" and the more specific statement of intent.
    for (const name of names) {
        const fileValue = fromFile.get(name);
        if (fileValue !== undefined) {
            resolved.set(name, { value: fileValue, source: 'file' });
            continue;
        }
        const envValue = fromEnv.get(name);
        if (envValue !== undefined)
            resolved.set(name, { value: envValue, source: 'env' });
    }
    return {
        has(name) {
            return resolved.has(name);
        },
        get(name) {
            return resolved.get(name)?.value ?? null;
        },
        fingerprint(names) {
            if (names.length === 0)
                return null;
            const parts = [];
            for (const name of names) {
                const entry = resolved.get(name);
                if (entry === undefined)
                    return null; // any missing one means no fingerprint can be given
                parts.push(`${name}\u0000${entry.value}\u0000${entry.source}`);
            }
            // Sorted so the fingerprint is order-independent: reordering credentials is not a change.
            parts.sort();
            return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
        },
        describe(names) {
            return names.map((name) => {
                const entry = resolved.get(name);
                return {
                    name,
                    present: entry !== undefined,
                    source: entry?.source ?? null,
                };
            });
        },
    };
}
/**
 * `.env` files that may layer over **the current Linux user's environment** — the default host.
 *
 * The host is a **variable**, never a constant: no agent gets hard-coded as the host. The default
 * is the user's own environment (process environment variables); a host may declare itself with
 * `FORAGIX_HOST_ENV=/path/to/.env`; the working directory's `.env` rounds out the local layer.
 * The later file wins (matching `load_dotenv(override=True)`), so any declared layer reads last.
 */
export function agentEnvFiles(env, cwd, explicitPath = null, exists = existsSync) {
    if (explicitPath !== null)
        return [explicitPath].filter(exists);
    // Order matters: the later entry wins. CWD first, then an explicitly declared host layer.
    const out = [join(cwd, '.env')];
    const declared = env['FORAGIX_HOST_ENV'];
    if (typeof declared === 'string' && declared !== '')
        out.push(declared);
    return out.filter(exists);
}
//# sourceMappingURL=load.js.map