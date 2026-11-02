/**
 * Firecrawl adapter (v2 search + scrape).
 *
 * Facts below were verified 2026-11-02 against docs.firecrawl.dev and the official pricing
 * page (documents/providers/firecrawl.md).
 *
 *  - Search: `POST /v2/search` with `{query, limit}` (limit 1–100, default 10); response
 *    `data.web[]` with `title`/`description`/`url`. `scrapeOptions` is NOT sent: in-page
 *    content extraction belongs to fetch, and mixing it here would burn extra credits.
 *  - Fetch: `POST /v2/scrape` with `{url}`; response `data` with `markdown`/`html`/`rawHtml`
 *    and `metadata{title, sourceURL}`. Content preference: markdown → html → rawHtml.
 *  - Billing: `credits` — search costs 2 credits per call (the default request of 10 results;
 *    billed per 10-result block), scrape 1 credit/page; one shared balance. Free tier is
 *    1,000 credits/month, refreshed monthly; beyond that PAYG in $5 increments is available,
 *    so usage is billable and `canCharge` is true (the paid gate applies by default).
 *  - Verified error semantics: 402 = credit exhaustion (quota, monthly), 401 = key rejected,
 *    403 = plan/scope/site unsupported (our problem — not auth, since keyed access failures
 *    return 401), 429 carries `Retry-After` in seconds when available.
 */
import type { ProviderAdapter } from '../types.js';
export declare const firecrawlAdapter: ProviderAdapter;
