import { SqliteAdapter } from '../src/db/sqlite.js';
import { Engine } from '../src/engine.js';
import type { ProviderAdapter } from '../src/providers/types.js';
interface Canned {
    status: number;
    body: string;
    headers?: Record<string, string>;
}
interface Harness {
    engine: Engine;
    db: SqliteAdapter;
    close(): void;
}
export declare function makeEngine(options?: {
    yaml?: string;
    routes?: Record<string, Canned>;
    env?: NodeJS.ProcessEnv;
    adapters?: readonly ProviderAdapter[];
    now?: () => number;
    fetchImpl?: typeof globalThis.fetch;
}): Harness;
export {};
