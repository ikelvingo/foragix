import type { SqliteAdapter } from './sqlite.js';
/** Schema version. Increment when the persisted schema changes. */
export declare const SCHEMA_VERSION = 2;
export declare const SCHEMA_VERSION_KEY = "schema_version";
/** Fingerprint of the DDL text. Used to detect "the DDL changed but the seed file was not rebuilt". */
export declare const SCHEMA_DDL_HASH_KEY = "schema_ddl_hash";
export declare function normalizeDdl(ddl: string): string;
/** Compute the fingerprint of the DDL. */
export declare function ddlHash(ddl: string): string;
/** Apply the DDL to the database. Idempotent — everything in the DDL uses `IF NOT EXISTS`. */
export declare function applySchema(db: SqliteAdapter, ddl: string): void;
/**
 * Ensure the database's schema version matches what the code expects.
 * Returns the version actually read (null means the database has no version record, usually an empty database or an uninitialized seed).
 */
export declare function readSchemaVersion(db: SqliteAdapter): number | null;
export interface SchemaCheck {
    ok: boolean;
    actual: number | null;
    expected: number;
    /** The explanation given when migration is needed; null when ok is true. */
    message: string | null;
}
/** Compare versions. Migrations are never automatic — a mismatch is always an explicit decision. */
export declare function checkSchemaVersion(db: SqliteAdapter, expected?: number): SchemaCheck;
/** Parse column names from the supported `CREATE TABLE` DDL syntax. */
export declare function parseDdlColumns(ddl: string): Map<string, string[]>;
/** Probe every column parsed from the current DDL; return false when any table or column is missing. */
export declare function probeSchema(db: SqliteAdapter, ddl: string): {
    ok: boolean;
    message: string | null;
};
/** Write the version record. Called after initialization or migration completes. */
export declare function writeSchemaVersion(db: SqliteAdapter, version?: number, ddl?: string): void;
/** Verify the DDL fingerprint when the database contains one; legacy databases without it skip this check. */
export declare function checkDdlHash(db: SqliteAdapter, ddl: string): {
    ok: boolean;
    message: string | null;
};
