/**
 * Zhihu data open-platform adapter.
 *
 * Facts below were verified 2026-11-02 against developer.zhihu.com docs and the platform's
 * own HTTP reference (see documents/providers/zhihu.md).
 *
 *  - Search-only: `GET /api/v1/content/zhihu_search` and `GET /api/v1/content/global_search`,
 *    chosen by the account option `db`. Auth: `Authorization: Bearer <access secret>` plus a
 *    `X-Request-Timestamp` header with the current unix time in seconds.
 *  - Query params: `Query` (required), `Count` (1–20 — `maxResults` clamped), `SearchDB`
 *    (global only), `Filter` grammar is not exposed by this adapter (hardcoded request shape).
 *  - Response: `{Code, Message, Data: {HasMore, Items[]}}`; Items carry `Title`, `Url`,
 *    `ContentText` (highlights wrapped in <em> — stripped here for a clean snippet), plus
 *    author/authority metadata. Pagination via `HasMore` is not followed by this adapter:
 *    a search call answers what the vendor returned for the count sent.
 *  - Quota: invited-test terms — 5,000 calls/day per search capability and nothing beyond a
 *    bespoke business plan (not yet chargeable), so `canCharge` is false; declared as a
 *    day-period quota with a 5,000/day ceiling.
 */
import type { ProviderAdapter } from '../types.js';
export declare const zhihuAdapter: ProviderAdapter;
