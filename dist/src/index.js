/**
 * foragix public entry point.
 *
 * The caller is an LLM, not a human: normal responses carry no quota information, a structured
 * refusal appears only when nothing is left to switch to, and status is a read-only tool rather
 * than an operator CLI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDefaultConfig, mergeDefaultProviders } from './config/defaults.js';
import { loadConfigFile } from './config/load.js';
import { loadCredentials } from './credentials/load.js';
import { Engine } from './engine.js';
import { ADAPTERS, createSchemaLookup } from './providers/registry.js';
import { ensureDatabase } from './runtime/db.js';
import { findSkillRoot } from './runtime/root.js';
/** Package root directory. Used to locate sql/ and seed/. */
const PACKAGE_ROOT = findSkillRoot(dirname(fileURLToPath(import.meta.url)));
function readDdl() {
    return readFileSync(join(PACKAGE_ROOT, 'sql', 'schema.sql'), 'utf8');
}
/**
 * Create a foragix instance.
 *
 * All initialization is done at load time: config validation → credential resolution → database
 * readiness (including copying from the seed) → status row seeding → static value re-seeding →
 * gate sync (credential presence; brave's local cap is enforced per call). **The first call performs no initialization at all.**
 */
export function createForagix(options) {
    const adapters = options.adapters ?? ADAPTERS;
    const lookup = createSchemaLookup(adapters);
    // A config validation failure throws ConfigError, carrying all the problems.
    // With no config file the built-in defaults apply, so the skill runs on install.
    const config = options.configPath === null
        ? buildDefaultConfig(adapters)
        : mergeDefaultProviders(loadConfigFile(options.configPath, { lookup }), adapters);
    const credentials = loadCredentials({
        ...(options.env === undefined ? {} : { env: options.env }),
        filePath: options.credentialFilePath ?? null,
        ...(options.credentialFilePaths === undefined ? {} : { filePaths: options.credentialFilePaths }),
    });
    const handle = ensureDatabase({ dataDir: options.dataDir, ddl: readDdl() });
    const adapterMap = new Map(adapters.map((a) => [a.id, a]));
    const engine = new Engine({
        db: handle.db,
        config,
        credentials,
        adapters: adapterMap,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        now: options.now ?? Date.now,
    });
    engine.bootstrap();
    return {
        config,
        search: (req) => engine.search(req),
        fetch: (req) => engine.fetch(req),
        status: (opts) => engine.status(opts?.onlyProblems ?? false),
        close: () => handle.db.close(),
    };
}
export { loadCredentials, parseEnvFile } from './credentials/load.js';
export { ConfigError } from './config/types.js';
export { ADAPTERS, NOT_IMPLEMENTED } from './providers/registry.js';
export { BIT, decodeReasons } from './db/bits.js';
export { SCHEMA_VERSION } from './db/schema.js';
export { suppressSqliteExperimentalWarning } from './runtime/warnings.js';
//# sourceMappingURL=index.js.map