export type CredentialSource = 'env' | 'file';
/** Redacted description: contains only the name and the source, never the value. */
export interface CredentialPresence {
    name: string;
    present: boolean;
    source: CredentialSource | null;
}
export interface CredentialView {
    /** Whether this name resolves to a non-empty value. */
    has(name: string): boolean;
    /** Retrieve a credential value. For use only when issuing requests — it must never be written to logs, SQLite, or error messages. */
    get(name: string): string | null;
    /** Returns the fingerprint when all names are present, otherwise null. */
    fingerprint(names: readonly string[]): string | null;
    /** Redacted description, safe to write to logs and status output. */
    describe(names: readonly string[]): CredentialPresence[];
}
/** Parse `.env`-style text. Only `KEY=VALUE` is supported; blank lines and `#` comments are ignored; values may be wrapped in a matching pair of quotes. */
export declare function parseEnvFile(text: string): Map<string, string>;
interface LoadOptions {
    /** Process environment variable snapshot. Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Path to the local private credential file; null / omitted means not to use one. */
    filePath?: string | null;
    /** Ordered `.env` files, later ones overriding earlier ones; used when `filePath` is absent. */
    filePaths?: readonly string[];
    /** Injection point for reading the file, for testing convenience. */
    readFile?: (path: string) => string;
}
export declare function loadCredentials(options?: LoadOptions): CredentialView;
/**
 * `.env` files that may layer over **the current Linux user's environment** — the default host.
 *
 * The host is a **variable**, never a constant: no agent gets hard-coded as the host. The default
 * is the user's own environment (process environment variables); a host may declare itself with
 * `FORAGIX_HOST_ENV=/path/to/.env`; the working directory's `.env` rounds out the local layer.
 * The later file wins (matching `load_dotenv(override=True)`), so any declared layer reads last.
 */
export declare function agentEnvFiles(env: NodeJS.ProcessEnv, cwd: string, explicitPath?: string | null, exists?: (p: string) => boolean): string[];
export {};
