/**
 * HTTP helper shared by the adapters: issues a request (including the timeout) and normalizes the
 * result into an AdapterOutcome. The verdict on status-code semantics is left to `classifyResponse`.
 */
import type { AdapterOutcome } from './types.js';
import { classifyResponse, type ProviderErrorHints } from '../errors/classify.js';
export declare const DEFAULT_TIMEOUT_MS = 15000;
export interface HttpResult {
    readonly status: number;
    /** Response headers, with key names already lowercased. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}
export interface RequestOptions {
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    /** JSON request body. Mutually exclusive with `body`. */
    readonly json?: unknown;
    readonly body?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}
/**
 * Issues a single request.
 * Network-layer failures (connection / DNS / TLS / timeout) are all normalized to transient failure —
 * they **have no determinable recovery condition**, so they set no persistent flag and only enter cooldown.
 */
export declare function request(fetchImpl: typeof globalThis.fetch, url: string, options?: RequestOptions): Promise<AdapterOutcome<HttpResult>>;
/** Applies the generic classification rules to a response already obtained. */
export declare function interpret(result: HttpResult, hints: ProviderErrorHints | undefined, now: number): ReturnType<typeof classifyResponse>;
/** Safely parses JSON. Returns null on failure; the caller decides whether that counts as a parse failure. */
export declare function parseJson<T>(body: string): T | null;
