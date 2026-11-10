/**
 * Parallel adapter.
 *
 * Facts below were verified 2026-11-10 against the official OpenAPI document plus live probes.
 *
 *  - Search: `POST https://api.parallel.ai/v1/search` with header `x-api-key`. The verified
 *    body carries `search_queries` (required) and `objective`; `mode` is hardcoded to `fast`
 *    because the vendor default is `advanced`, which costs five times as much.
 *  - Fetch: `POST /v1/extract` with `urls: [url]` and `advanced_settings.full_content: true`;
 *    the response carries `full_content` (markdown) plus `errors[]` for URLs that failed.
 *  - Quota: a $5 monthly credit for organizations with a credit card; non-accumulating and
 *    expiring at month end. At the `fast` search rate and the extract rate that is roughly
 *    5,000 requests, so the local ceiling is diagnostic rather than an enforced budget.
 *  - Verified errors: 401 invalid key (`{code:16,...}`), 402 insufficient credit, 422 request
 *    validation, 429 short-window rate limit. Parallel words its 429 body with "quota", so the
 *    short window is pinned by status code before the generic body matcher can see it.
 */
import type { ProviderAdapter } from '../types.js';
export declare const parallelAdapter: ProviderAdapter;
