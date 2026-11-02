import { SqliteAdapter } from '../db/sqlite.js';
export interface EnsureDatabaseOptions {
    /** User data directory. The runtime database lives here. */
    readonly dataDir: string;
    /** DDL text from the package. Required: without it the database cannot be created or validated. */
    readonly ddl: string;
    readonly busyTimeoutMs?: number;
}
export interface DatabaseHandle {
    readonly db: SqliteAdapter;
    readonly path: string;
    /** Whether this load created the file. */
    readonly created: boolean;
}
/**
 * Ensure the runtime database exists and is open.
 * Missing database → apply the DDL; existing database → validate it. Migrations are never automatic.
 */
export declare function ensureDatabase(options: EnsureDatabaseOptions): DatabaseHandle;
