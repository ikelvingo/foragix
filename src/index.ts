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
import type { Config } from './config/types.js';
import { loadCredentials, type CredentialView } from './credentials/load.js';
import { Engine, type FailureReport, type ProviderReport } from './engine.js';
import { ADAPTERS, createSchemaLookup } from './providers/registry.js';
import type { FetchDocument, InformationDocument, InformationRequest, ProviderAdapter, SearchHit } from './providers/types.js';
import { ensureDatabase } from './runtime/db.js';
import { findSkillRoot } from './runtime/root.js';

/** Package root directory. Used to locate sql/ and seed/. */
const PACKAGE_ROOT = findSkillRoot(dirname(fileURLToPath(import.meta.url)));

export interface ForagixOptions {
  /**
   * Config file path (YAML). **null means use the built-in defaults**, which enable every
   * provider that has an adapter. A config file is only needed to change something.
   */
  readonly configPath: string | null;
  /** User data directory. The runtime database copy lives here. */
  readonly dataDir: string;
  /** One explicit credential file; when set it replaces the `.env` search entirely. */
  readonly credentialFilePath?: string | null;
  /** Ordered `.env` files outside the skill, later ones overriding earlier ones. */
  readonly credentialFilePaths?: readonly string[];
  /** Snapshot of the process environment variables. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Injected adapters; defaults to the registry. Replaceable in tests. */
  readonly adapters?: readonly ProviderAdapter[];
}

export interface Foragix {
  readonly config: Config;
  search(req: { query: string; maxResults?: number; site?: 'zhihu' }): Promise<SearchResult>;
  fetch(req: { url: string }): Promise<FetchResult>;
  information(req: InformationRequest): Promise<InformationResult>;
  /** Read-only status. For the LLM, not a CLI for humans. */
  status(options?: { onlyProblems?: boolean }): ProviderReport[];
  close(): void;
}

// Success carries the results only (config format §10.1); provider selection stays internal.
export type SearchResult = { ok: true; data: readonly SearchHit[] } | FailureReport;
export type FetchResult = { ok: true; data: FetchDocument } | FailureReport;
export type InformationResult = { ok: true; data: InformationDocument } | FailureReport;
export type { InformationRequest, InformationDocument };

export type { ProviderReport, FailureReport };

function readDdl(): string {
  return readFileSync(join(PACKAGE_ROOT, 'sql', 'schema.sql'), 'utf8');
}

/**
 * Create a foragix instance.
 *
 * All initialization is done at load time: config validation → credential resolution → database
 * readiness (including copying from the seed) → status row seeding → static value re-seeding →
 * gate sync (credential presence; brave's local cap is enforced per call). **The first call performs no initialization at all.**
 */
export function createForagix(options: ForagixOptions): Foragix {
  const adapters = options.adapters ?? ADAPTERS;
  const lookup = createSchemaLookup(adapters);

  // A config validation failure throws ConfigError, carrying all the problems.
  // With no config file the built-in defaults apply, so the skill runs on install.
  const config =
    options.configPath === null
      ? buildDefaultConfig(adapters)
      : mergeDefaultProviders(loadConfigFile(options.configPath, { lookup }), adapters);

  const credentials: CredentialView = loadCredentials({
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
    information: (req) => engine.information(req),
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
