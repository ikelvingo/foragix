/**
 * TinyFish adapter (TinySearch + TinyFetch).
 *
 * Facts below were verified 2026-11-02 against docs.tinyfish.ai, replacing the
 * 2026-10-28 "quota attribution undecided" verdict once the actual shape was known
 * (documents/providers/tinyfish.md).
 *
 *  - Two hosts, two capabilities: `GET https://api.search.tinyfish.ai?query=…` and
 *    `POST https://api.fetch.tinyfish.ai` (`{urls, format}`, one URL per call here),
 *    auth `X-API-Key: $TINYFISH_API_KEY`.
 *  - Search response: `{results: [{title, snippet, url, …}]}`; no documented count/limit
 *    parameter (the "500 req/hour" figure of the earlier assessment appears nowhere
 *    official — the verified per-minute limits are 30 search/min and 150 URL/min).
 *  - Fetch response keeps HTTP 200 and carries per-URL failures inside
 *    `{results: [], errors: [{url, error, …}]}` — a body-level error list is "our
 *    problem" (site refusal), not a transport failure.
 *  - Quota: daily free allowances (12k search/day, 1k fetch URLs/day) resetting at
 *    00:00 UTC; beyond them, a positive prepaid wallet is billed, so `canCharge` is
 *    true and the paid gate applies by default. The two allowances differ per
 *    capability, which the single provider-level dayLimit cannot represent — so
 *    both `dayLimit` stays null (not locally countable) and the day-quota bit is set
 *    only by the verified 402 availability signs (FREE_ALLOWANCE_EXHAUSTED /
 *    INSUFFICIENT_CREDITS, both daily-reset).
 */
import type { ProviderAdapter } from '../types.js';
export declare const tinyfishAdapter: ProviderAdapter;
