/**
 * You.com adapter (ydc-index.io v1).
 *
 * Facts below were verified 2026-11-02 against you.com's official docs — the current
 * documented REST surface, replacing the 2026-10-28 assessment whose free path rested on
 * MCP only (documents/providers/you.md).
 *
 *  - Endpoints: `POST /v1/search` and `POST /v1/contents` on `https://ydc-index.io`,
 *    auth `X-API-Key: $YDC_API_KEY`. Only POST is used; the GET form is maintenance-mode.
 *  - Search body: `{query, count}` (count = `maxResults`, clamped 1–100); the `extraction`
 *    add-on is NOT sent — in-page highlights/full-page belong to fetch and would bill extra
 *    ($1/1k live-crawled pages).
 *  - Search response: `results.web[]` with `title`/`url`/`description`/`snippets[]`.
 *  - Fetch body: `{urls: [url], formats: ["markdown"]}`; response is a JSON **array** with
 *    items `{url, title, markdown?, html?}`.
 *  - Billing: pay-as-you-go credits (search $5/1k calls, contents $1/1k pages), no
 *    day/month reset — so the adapter declares `quotaPeriod 'none'`; a 402-exhaustion bit
 *    clears only through an external event (credit top-up). `canCharge` is true: the paid
 *    gate applies by default.
 *  - A 429 whose body carries `spend_cap_exceeded` is a per-key spending cap that retrying
 *    cannot clear — it is classified as a durable quota state (period unknown), NOT a
 *    short-window cooldown, so the engine stops hammering a capped key
 *    (documents/providers/you.md → Errors; verified 2026-11-02).
 */
import type { ProviderAdapter } from '../types.js';
export declare const youAdapter: ProviderAdapter;
