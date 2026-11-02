/**
 * MiniMax adapter (Token/M-Plan web search).
 *
 * Facts below were verified 2026-11-02 against the first-party mmx-cli SDK sources in the local
 * install and the official M-Plan docs; the official REST reference page for the endpoint is
 * currently 404, which is an accepted, documented gap (see documents/providers/minimax.md).
 *
 *  - Search-only: MiniMax publishes no standalone fetch/web-reader REST endpoint.
 *  - Request: `POST ${base}/v1/coding_plan/search`, body `{"q": "<query>"}`; the endpoint returns
 *    at most 10 results and does not support pagination, so `maxResults` cannot be honored.
 *  - Success response: `{"organic": [{title, link, snippet, date}]}`.
 *  - HTTP-200 envelope errors: `base_resp.status_code`; `1028`/`1030` are verified quota codes;
 *    `1002`/`1039`/`1026`/`1027` are moderation/withholding codes; `2061` model not on plan.
 *  - Quota model: dual 5-hour rolling window + 7-day weekly window, probed via
 *    `GET /v1/token_plan/remains`. The engine's bitmask cannot represent those windows, and
 *    approximating a 5-hour window as a day or a rate-limit cooldown was explicitly rejected.
 *    So this adapter declares `quotaPeriod 'none'`: an exhaustion bit is durable and clears
 *    only through an external event — config reload, credential change, or manual intervention.
 *  - Consumption draws down a pre-purchased plan subscription, so `canCharge` is true and the
 *    paid gate applies (default off) until the user accepts plan usage.
 */
import type { ProviderAdapter } from '../types.js';
export declare function minimaxAdapterFor(id: 'minimax' | 'minimax_cn'): ProviderAdapter;
export declare const minimaxAdapter: ProviderAdapter;
export declare const minimaxCnAdapter: ProviderAdapter;
