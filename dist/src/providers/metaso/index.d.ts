/**
 * Metaso (秘塔) adapter.
 *
 * Facts below were verified 2026-11-02 (live probe + metaso.cn API docs; see
 * documents/providers/metaso.md).
 *
 *  - Search-only: `POST https://metaso.cn/api/v1/search`, Bearer auth
 *    (`{q, scope: "all", count}`); response `{credits, searchParameters, webpages[]}` with
 *    `webpages[{title, link, score, snippet}]`. The `credits` field carries the account
 *    balance — it is evidence for status output, not a per-call cost signal.
 *  - Quota model: prepaid credits draw down per search (counted locally against a monthly
 *    ceiling is NOT possible without a documented call price, so limits stay null and the
 *    balance-exhaustion bit clears only through an external event).
 *  - Billing: consumption of a prepaid credit balance — `canCharge` true, the paid gate
 *    applies by default (same stance as the other credit-consumption providers).
 */
import type { ProviderAdapter } from '../types.js';
export declare const metasoAdapter: ProviderAdapter;
