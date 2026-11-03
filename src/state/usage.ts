/**
 * Observed calls per *endpoint*, kept apart from quota bookkeeping.
 *
 * The vendors meter these tools on plans whose sharing and reset boundaries are not documented
 * (Baidu's Baike tools list their own allowances; Zhihu's content endpoints share a credential
 * with search). Guessing a free balance from local counters would be wrong, and refusing calls on
 * a made-up ceiling would be worse. So the counters here stay purely observational: they record
 * that a call happened, never that a quota is left.
 */
import type { SqliteAdapter } from '../db/sqlite.js';

export type ObservedEndpoint = 'encyclopedia' | 'video' | 'content' | 'information' | 'search' | 'fetch';

export interface ObservedUsage {
  readonly count: number;
  readonly first_at: number;
  readonly last_at: number;
}

function key(providerId: string, endpoint: ObservedEndpoint): string {
  return `observed:${providerId}:${endpoint}`;
}

/** Add one observed call. Never writes a quota key, a flag or a provider row. */
export function recordObserved(
  db: SqliteAdapter,
  providerId: string,
  endpoint: ObservedEndpoint,
  now: number,
): void {
  // Read-modify-write under BEGIN IMMEDIATE: two processes finishing a call at the same moment
  // must not each write count+1 from the same starting value.
  db.transaction(() => {
    const current = readObserved(db, providerId, endpoint);
    const next: ObservedUsage = {
      count: (current?.count ?? 0) + 1,
      first_at: current?.first_at ?? now,
      last_at: now,
    };
    db.writeMeta(key(providerId, endpoint), JSON.stringify(next));
  });
}

/** Read the observed counters; null means this endpoint has never been called. */
export function readObserved(db: SqliteAdapter, providerId: string, endpoint: ObservedEndpoint): ObservedUsage | null {
  const raw = db.readMeta(key(providerId, endpoint));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ObservedUsage>;
    if (typeof parsed.count !== 'number' || typeof parsed.first_at !== 'number' || typeof parsed.last_at !== 'number') return null;
    return { count: parsed.count, first_at: parsed.first_at, last_at: parsed.last_at };
  } catch {
    return null;
  }
}
