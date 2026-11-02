/**
 * Runtime database setup: schema is applied from the shipped DDL on first use.
 * There is no seed artifact — `sql/schema.sql` is the single authority, and every table in it is
 * `CREATE TABLE IF NOT EXISTS`, so applying it is idempotent. All initialization happens here,
 * at load time; the request path only does lazy resets.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SqliteAdapter } from '../db/sqlite.js';
import { applySchema, checkDdlHash, checkSchemaVersion, probeSchema, writeSchemaVersion } from '../db/schema.js';
const DB_FILENAME = 'foragix.db';
/**
 * Ensure the runtime database exists and is open.
 * Missing database → apply the DDL; existing database → validate it. Migrations are never automatic.
 */
export function ensureDatabase(options) {
    const dbPath = join(options.dataDir, DB_FILENAME);
    const created = !existsSync(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = SqliteAdapter.open(dbPath, { wal: true, ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) }, Date.now);
    try {
        if (created) {
            applySchema(db, options.ddl);
            writeSchemaVersion(db, undefined, options.ddl);
        }
        // Load-time validation 1/3: schema version.
        const check = checkSchemaVersion(db);
        if (!check.ok) {
            throw new Error(`Database schema validation failed: ${check.message ?? 'unknown reason'} (${dbPath})`);
        }
        // Load-time validation 2/3: per-column probe against the DDL.
        const probe = probeSchema(db, options.ddl);
        if (!probe.ok) {
            throw new Error(`Database structure probe failed: ${probe.message ?? 'unknown reason'} (${dbPath})`);
        }
        // Load-time validation 3/3: DDL fingerprint (catches db/DDL drift between releases).
        const ddlCheck = checkDdlHash(db, options.ddl);
        if (!ddlCheck.ok) {
            throw new Error(`Database schema fingerprint validation failed: ${ddlCheck.message ?? 'unknown reason'} (${dbPath})`);
        }
    }
    catch (err) {
        db.close();
        throw err;
    }
    return { db, path: dbPath, created };
}
//# sourceMappingURL=db.js.map