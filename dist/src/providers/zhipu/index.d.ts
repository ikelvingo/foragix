/**
 * Zhipu BigModel web search adapter.
 *
 * Facts below were verified 2026-11-02 against docs.bigmodel.cn; the standalone REST tool
 * exists and is pay-as-you-go — the dual 5-hour/weekly Coding-Plan windows apply to the
 * plan's MCP surfaces only, not to this REST endpoint (documents/providers/zhipu.md).
 *
 *  - Search: `POST https://open.bigmodel.cn/api/paas/v4/web_search`, Bearer auth.
 *    Body: `{search_query, search_engine, search_intent: false, count}` — engine pinned to
 *    the base `search_std` (tier upgrades belong to account config, not per-call), query
 *    truncated to the documented 70-char maximum, count = `maxResults` clamped 1–50.
 *    Response: `search_result[]` with `title`/`content`/`link`.
 *  - Fetch: `POST /api/paas/v4/reader` with `{url}` — response `reader_result` with
 *    `content`/`description`/`title`/`url`.
 *  - Billing: pay-as-you-go points per call; no free-call window is published for REST —
 *    `canCharge` true (paid gate by default), `quotaPeriod 'none'` (concurrency-based
 *    limiting with in-band cap codes; no locally resettable period).
 *  - Verified business codes: auth failures `1000/1001/1003/1005` (→ 401 semantics),
 *    `1308` in-band quota cap carrying an in-message reset time.
 */
import type { ProviderAdapter } from '../types.js';
export declare function zhipuAdapterFor(id: 'zhipu' | 'zhipu_cn', opts: {
    defaultBaseUrl: string;
    defaultEngine: 'search_std' | 'search-prime';
}): ProviderAdapter;
export declare const zhipuAdapter: ProviderAdapter;
export declare const zhipuCnAdapter: ProviderAdapter;
