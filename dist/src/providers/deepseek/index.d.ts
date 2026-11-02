/**
 * DeepSeek adapter (Search & Fetch tools API).
 *
 * Facts below were verified 2026-11-02 against api-docs.deepseek.com/guides/search and the
 * official pricing page (documents/providers/deepseek.md).
 *
 *  - Endpoints: `POST /v1/tools/search` and `POST /v1/tools/fetch`, Bearer-auth.
 *  - Search body: `query` (required, 1–128 chars), optional `count` 1–50 (default 10 —
 *    `maxResults` maps onto it); `need_content` stays false (page content belongs to fetch).
 *  - Fetch body: `{url}`; response `{title, content}` with content as Markdown.
 *  - Billing: every successful request is billable at $0.75/1,000 (live since 2026-11-01);
 *    there is no periodic free quota, so the adapter declares `quotaPeriod 'none'` — a
 *    balance exhaustion bit clears only through an external event (top-up is outside the
 *    engine's control). `canCharge` is true: the paid gate applies by default.
 *  - Verified error semantics: 402 = balance exhausted (quota), 401 = key rejected,
 *    429 = account/per-domain QPS exceeded (short window), 404 (fetch only) = no usable
 *    page content — refused by the site, not a transport failure, so "our problem".
 */
import type { ProviderAdapter } from '../types.js';
export declare const deepseekAdapter: ProviderAdapter;
