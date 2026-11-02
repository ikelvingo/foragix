/**
 * Brave Search adapter.
 *
 * Facts below were verified 2026-11-02 against api-dashboard.search.brave.com official pages
 * (see documents/providers/brave.md).
 *
 *  - Search-only: the Search API publishes no page-content fetch endpoint
 *    (`include_fetch_metadata` returns metadata about search results, not page content).
 *  - Request: `GET /res/v1/web/search` with `X-Subscription-Token`; only `q` and `count` are sent
 *    (the request shape is hardcoded; `count` maps `maxResults`, clamped to the 1–20 API range).
 *  - Success response: `web.results[]` with `title`/`url`/`description`.
 *  - Rate limiting: 429 on exceed; every response carries `X-RateLimit-Remaining` with two CSV
 *    values (per-second window, monthly window) and `X-RateLimit-Reset` in seconds. The 429 body
 *    shape is undocumented, so the header pair is the only verified signal that separates
 *    a short-window denial from **monthly quota exhaustion**; when the monthly remaining value
 *    is 0 the response is classified as monthly quota exhaustion instead of cooldown.
 *  - Quota: $5 credits auto-applied monthly ≈ 1,000 requests at the Search rate ($5.00 per
 *    1,000 requests); only successful requests count. Usage beyond the free credits is
 *    billable, so `canCharge` is true and the paid gate applies (default off).
 */
import type { ProviderAdapter } from '../types.js';
export declare const braveAdapter: ProviderAdapter;
