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
/** Add one observed call. Never writes a quota key, a flag or a provider row. */
export declare function recordObserved(db: SqliteAdapter, providerId: string, endpoint: ObservedEndpoint, now: number): void;
/** Read the observed counters; null means this endpoint has never been called. */
export declare function readObserved(db: SqliteAdapter, providerId: string, endpoint: ObservedEndpoint): ObservedUsage | null;
