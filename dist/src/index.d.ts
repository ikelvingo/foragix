import type { Config } from './config/types.js';
import { type FailureReport, type ProviderReport } from './engine.js';
import type { FetchDocument, ProviderAdapter, SearchHit } from './providers/types.js';
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
    search(req: {
        query: string;
        maxResults?: number;
    }): Promise<SearchResult>;
    fetch(req: {
        url: string;
    }): Promise<FetchResult>;
    /** Read-only status. For the LLM, not a CLI for humans. */
    status(options?: {
        onlyProblems?: boolean;
    }): ProviderReport[];
    close(): void;
}
export type SearchResult = {
    ok: true;
    data: readonly SearchHit[];
} | FailureReport;
export type FetchResult = {
    ok: true;
    data: FetchDocument;
} | FailureReport;
export type { ProviderReport, FailureReport };
/**
 * Create a foragix instance.
 *
 * All initialization is done at load time: config validation → credential resolution → database
 * readiness (including copying from the seed) → status row seeding → static value re-seeding →
 * gate sync (credential presence; brave's local cap is enforced per call). **The first call performs no initialization at all.**
 */
export declare function createForagix(options: ForagixOptions): Foragix;
export { loadCredentials, parseEnvFile } from './credentials/load.js';
export { ConfigError } from './config/types.js';
export { ADAPTERS, NOT_IMPLEMENTED } from './providers/registry.js';
export { BIT, decodeReasons } from './db/bits.js';
export { SCHEMA_VERSION } from './db/schema.js';
export { suppressSqliteExperimentalWarning } from './runtime/warnings.js';
