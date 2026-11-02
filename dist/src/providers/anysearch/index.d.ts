/**
 * AnySearch adapter.
 *
 * Facts below were verified 2026-11-02 against the vendor's own docs hub and pricing page,
 * superseding the earlier "unconfirmed" verdict of the 2026-10-28 assessment
 * (documents/providers/anysearch.md).
 *
 *  - Endpoints: `POST /v1/search` (`{query, max_results}` 1–10, no pagination) and
 *    `POST /v1/extract` (`{url}` strict single-field body) — search and fetch share one
 *    `/v1` quota pool. Bearer auth; `Content-Type: application/json` is enforced (415).
 *  - Success envelope: `{code: 0, message, data: {results|…}}`.
 *  - Verified error semantics: 402 = quota exhausted, 401/403 = key issues, 429 = QPS,
 *    415/422 = request construction (our problem), 502 = upstream unavailable (transient).
 *  - Quota: free plan 1,000 calls/day (10 QPS); Pro $3/1,000 calls is billable beyond it,
 *    so `canCharge` is true (the paid gate applies by default) and the daily reset is
 *    tracked as a day-period quota. The reset clock timezone is undocumented; UTC is the
 *    explicit approximation.
 */
import type { ProviderAdapter } from '../types.js';
export declare const anysearchAdapter: ProviderAdapter;
