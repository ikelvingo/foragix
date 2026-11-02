/**
 * Doubao (火山引擎 search-infinity) adapter — the standalone REST channel behind
 * `open.feedcoopapi.com/search_api/*`, verified against the vendor console entry and the
 * first-party reference client (documents/providers/doubao.md; live-reviewed 2026-11-02).
 * The 2026-10-28 "not implementable" verdict is withdrawn: the REST surface exists.
 *
 *  - Two variants, same key and one shared quota pool:
 *      * `global` — `/search_api/global_search`, body `{query, doc_count}`; the server
 *        currently answers 10 docs fixed, so `maxResults` is applied client-side.
 *      * `custom` — `/search_api/web_search`, body `{Query, SearchType: "web", Count}`
 *        (Count really applies; richer Content).
 *  - Response envelope: `{ResponseMetadata: {Error?}, Result: {Documents?|WebResults?}}`;
 *    global items carry Title/Url/HostInfo/DocumentInfo{PublishTime, ContentTokenCount}/
 *    Snippet[{Type: text|image}]; custom items carry Title/Url/SiteName/PublishTime/Content.
 *  - Quota: 500 free searches/month shared by both variants; beyond it pay-per-call
 *    post-paid billing — `canCharge` true (paid gate applies by default), day/month reset
 *    monthly.
 */
import type { ProviderAdapter } from '../types.js';
export declare const doubaoAdapter: ProviderAdapter;
