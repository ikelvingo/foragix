/**
 * Keenable search and page-fetch adapter.
 *
 * API facts verified against https://docs.keenable.ai/api-reference:
 * - Search: POST /v1/search with `query` and optional `max_results` (1–50), X-API-Key auth.
 * - Fetch: GET /v1/fetch?url=..., returning Markdown content.
 * - Search and indexed fetch each count as one request against 100,000 free requests/month.
 *   Purchased credits are controlled by the Keenable account; this adapter does not impose a local cap.
 * - 402 means monthly allowance spent with no credits; 401/403 are credential errors; 429 is rate limiting.
 */
import type { ProviderAdapter } from '../types.js';
export declare const keenableAdapter: ProviderAdapter;
