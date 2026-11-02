/**
 * Schema version and structure checks. `sql/schema.sql` is the authoritative DDL.
 * Database setup and provider seeding occur during load, before the first request.
 */
import { createHash } from 'node:crypto';
/** Schema version. Increment when the persisted schema changes. */
export const SCHEMA_VERSION = 2;
export const SCHEMA_VERSION_KEY = 'schema_version';
/** Fingerprint of the DDL text. Used to detect "the DDL changed but the seed file was not rebuilt". */
export const SCHEMA_DDL_HASH_KEY = 'schema_ddl_hash';
/** Opening quote character → its closing character. */
const QUOTE_OPENERS = {
    "'": "'",
    '"': '"',
    '`': '`',
    '[': ']',
};
export function normalizeDdl(ddl) {
    // Pass 1: replace each comment with a single space, copying quoted runs verbatim.
    let stripped = '';
    let quote = null;
    let p = 0;
    while (p < ddl.length) {
        const ch = ddl[p];
        if (quote !== null) {
            if (ch === quote) {
                if (ddl[p + 1] === quote) {
                    stripped += ch + quote; // doubled close is an escape
                    p += 2;
                    continue;
                }
                quote = null;
                stripped += ch;
                p += 1;
                continue;
            }
            stripped += ch;
            p += 1;
            continue;
        }
        const close = QUOTE_OPENERS[ch];
        if (close !== undefined) {
            quote = close;
            stripped += ch;
            p += 1;
            continue;
        }
        if (ch === '-' && ddl[p + 1] === '-') {
            while (p < ddl.length && ddl[p] !== '\n')
                p += 1;
            stripped += ' ';
            continue;
        }
        if (ch === '/' && ddl[p + 1] === '*') {
            p += 2;
            while (p < ddl.length && !(ddl[p] === '*' && ddl[p + 1] === '/'))
                p += 1;
            p += 2; // consume the closing delimiter, or run past the end if unterminated
            stripped += ' ';
            continue;
        }
        stripped += ch;
        p += 1;
    }
    // Pass 2: collapse whitespace runs, again copying quoted runs verbatim.
    let out = '';
    quote = null;
    let i = 0;
    while (i < stripped.length) {
        const ch = stripped[i];
        if (quote !== null) {
            if (ch === quote) {
                if (stripped[i + 1] === quote) {
                    out += ch + quote;
                    i += 2;
                    continue;
                }
                quote = null;
                out += ch;
                i += 1;
                continue;
            }
            out += ch;
            i += 1;
            continue;
        }
        const close = QUOTE_OPENERS[ch];
        if (close !== undefined) {
            quote = close;
            out += ch;
            i += 1;
            continue;
        }
        if (/\s/.test(ch)) {
            while (i < stripped.length && /\s/.test(stripped[i]))
                i += 1;
            out += ' ';
            continue;
        }
        out += ch;
        i += 1;
    }
    return out.trim();
}
/** Compute the fingerprint of the DDL. */
export function ddlHash(ddl) {
    return createHash('sha256').update(normalizeDdl(ddl)).digest('hex').slice(0, 32);
}
/** Apply the DDL to the database. Idempotent — everything in the DDL uses `IF NOT EXISTS`. */
export function applySchema(db, ddl) {
    db.exec(ddl);
}
/**
 * Ensure the database's schema version matches what the code expects.
 * Returns the version actually read (null means the database has no version record, usually an empty database or an uninitialized seed).
 */
export function readSchemaVersion(db) {
    const raw = db.readMeta(SCHEMA_VERSION_KEY);
    if (raw === null)
        return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}
/** Compare versions. Migrations are never automatic — a mismatch is always an explicit decision. */
export function checkSchemaVersion(db, expected = SCHEMA_VERSION) {
    const actual = readSchemaVersion(db);
    if (actual === expected)
        return { ok: true, actual, expected, message: null };
    if (actual === null) {
        return {
            ok: false,
            actual,
            expected,
            message: 'The database is missing a schema_version record. If it is an empty database, initialize it from the seed file; otherwise check whether the file is intact',
        };
    }
    if (actual < expected) {
        return {
            ok: false,
            actual,
            expected,
            message: `Database schema version ${actual} is lower than the ${expected} the code expects; migration is required`,
        };
    }
    return {
        ok: false,
        actual,
        expected,
        message: `Database schema version ${actual} is higher than the ${expected} the code expects; please upgrade foragix`,
    };
}
/** Parse column names from the supported `CREATE TABLE` DDL syntax. */
export function parseDdlColumns(ddl) {
    const out = new Map();
    const withoutComments = ddl.replace(/--[^\n]*/g, '');
    const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
    let match;
    while ((match = tableRe.exec(withoutComments)) !== null) {
        const table = match[1];
        const start = tableRe.lastIndex;
        // Track string state: a `)` inside a literal does not close the table body.
        let depth = 1;
        let i = start;
        let scanInStr = false;
        for (; i < withoutComments.length && depth > 0; i += 1) {
            const ch = withoutComments[i];
            if (ch === "'") {
                if (scanInStr && withoutComments[i + 1] === "'") {
                    i += 1; // an escaped single quote, skipped as a unit
                    continue;
                }
                scanInStr = !scanInStr;
                continue;
            }
            if (scanInStr)
                continue;
            if (ch === '(')
                depth += 1;
            else if (ch === ')')
                depth -= 1;
        }
        const body = withoutComments.slice(start, Math.max(start, i - 1));
        // Split on top-level commas only; commas inside `CHECK (a, b)` are not column separators.
        const parts = [];
        let inner = 0;
        let current = '';
        let inStr = false;
        for (let j = 0; j < body.length; j += 1) {
            const ch = body[j];
            if (ch === "'") {
                if (inStr && body[j + 1] === "'") {
                    current += "''";
                    j += 1;
                    continue;
                }
                inStr = !inStr;
                current += ch;
                continue;
            }
            if (!inStr) {
                if (ch === '(')
                    inner += 1;
                else if (ch === ')')
                    inner -= 1;
                else if (ch === ',' && inner === 0) {
                    parts.push(current);
                    current = '';
                    continue;
                }
            }
            current += ch;
        }
        if (current.trim() !== '')
            parts.push(current);
        const columns = [];
        for (const rawLine of parts) {
            const line = rawLine.trim();
            if (line === '')
                continue;
            const first = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
            if (first === null)
                continue;
            const word = first[1].toUpperCase();
            // a table-level constraint is not a column
            if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'KEY'].includes(word))
                continue;
            columns.push(first[1]);
        }
        out.set(table, columns);
    }
    return out;
}
/** Probe every column parsed from the current DDL; return false when any table or column is missing. */
export function probeSchema(db, ddl) {
    const expected = parseDdlColumns(ddl);
    if (expected.size === 0) {
        return { ok: false, message: 'Could not parse the table structure from the DDL; the DDL format may be abnormal' };
    }
    for (const [table, columns] of expected) {
        if (columns.length === 0)
            continue;
        if (!db.canSelect(table, columns.join(', '))) {
            return {
                ok: false,
                message: `Table ${table} does not match the current DDL. This usually means the database was created by an older version; rebuild the runtime database, or perform an explicit migration`,
            };
        }
    }
    return { ok: true, message: null };
}
/** Write the version record. Called after initialization or migration completes. */
export function writeSchemaVersion(db, version = SCHEMA_VERSION, ddl) {
    db.writeMeta(SCHEMA_VERSION_KEY, String(version));
    if (ddl !== undefined)
        db.writeMeta(SCHEMA_DDL_HASH_KEY, ddlHash(ddl));
}
/** Verify the DDL fingerprint when the database contains one; legacy databases without it skip this check. */
export function checkDdlHash(db, ddl) {
    const stored = db.readMeta(SCHEMA_DDL_HASH_KEY);
    if (stored === null)
        return { ok: true, message: null };
    const actual = ddlHash(ddl);
    if (stored === actual)
        return { ok: true, message: null };
    return {
        ok: false,
        message: `The database's schema fingerprint does not match the current DDL (in database ${stored}, current ${actual}). This usually means the DDL changed after the database was created; delete the data directory or rebuild the database explicitly`,
    };
}
//# sourceMappingURL=schema.js.map