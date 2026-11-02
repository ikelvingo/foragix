/**
 * Ollama cloud search adapter.
 *
 * Facts below were verified 2026-11-02 (live probes + official docs; see
 * documents/providers/ollama.md).
 *
 *  - Search: `POST https://api.ollama.com/api/web_search` Bearer auth, body `{query}`,
 *    response `{results: [{title, url, content}]}`.
 *  - Fetch: `POST /api/web_fetch`, body `{url}`, response `{title, content}` (Markdown).
 *  - Billing: the web-tool APIs are free-tier APIs of the ollama cloud account — no per-call
 *    charge is documented on the current pages, so `canCharge` is false; if the vendor
 *    introduces pricing, the adapter version must be bumped.
 *  - Quota: no locally countable, vendor-declared reset window is published for these
 *    endpoints (`quotaPeriod 'none'`).
 */
import type { ProviderAdapter } from '../types.js';
export declare const ollamaAdapter: ProviderAdapter;
