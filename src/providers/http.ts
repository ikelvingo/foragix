/**
 * HTTP helper shared by the adapters: issues a request (including the timeout) and normalizes the
 * result into an AdapterOutcome. The verdict on status-code semantics is left to `classifyResponse`.
 */
import type { AdapterOutcome } from './types.js';
import { classifyNetworkError, classifyResponse, type ProviderErrorHints } from '../errors/classify.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

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

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Issues a single request.
 * Network-layer failures (connection / DNS / TLS / timeout) are all normalized to transient failure —
 * they **have no determinable recovery condition**, so they set no persistent flag and only enter cooldown.
 */
export async function request(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  options: RequestOptions = {},
): Promise<AdapterOutcome<HttpResult>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

  const init: RequestInit = {
    method: options.method ?? 'GET',
    signal,
    redirect: 'follow',
  };

  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    init.body = options.body;
  }
  init.headers = headers;

  try {
    const response = await fetchImpl(url, init);
    const body = await response.text();
    return {
      ok: true,
      usage: 0,
      data: { status: response.status, headers: headersToRecord(response.headers), body },
    };
  } catch (err) {
    return { ok: false, classification: classifyNetworkError(err) };
  }
}

/** Applies the generic classification rules to a response already obtained. */
export function interpret(
  result: HttpResult,
  hints: ProviderErrorHints | undefined,
  now: number,
): ReturnType<typeof classifyResponse> {
  return classifyResponse({ status: result.status, headers: result.headers, body: result.body, hints }, now);
}

/** Safely parses JSON. Returns null on failure; the caller decides whether that counts as a parse failure. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
