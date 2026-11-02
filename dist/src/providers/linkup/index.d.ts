/**
 * LinkUp adapter.
 *
 * Facts below were verified 2026-11-02 (live probes + official docs where reachable;
 * see documents/providers/linkup.md).
 *
 *  - Search: `POST https://api.linkup.so/v1/search`, Bearer auth. The verified body is
 *    `{"q": …, "depth": "standard", "outputType": "searchResults", "includeImages": false}`
 *    — the request shape is hardcoded; `outputType: sourcedAnswer` would spend extra budget
 *    on answer synthesis, which is not what a Search hop is for.
 *  - Fetch: `POST /v1/fetch` with `{url}`; response `content`/`title`.
 *  - Billing: prepaid account credits — `canCharge` true (paid gate applies by default),
 *    credit-based spend without a vendor reset window → `quotaPeriod 'none'`.
 *  - Verified error semantics: validation failures answer 400 with a
 *    `{error:{code:"VALIDATION_ERROR",details[]}}` envelope (our problem); 401 key rejected.
 */
import type { ProviderAdapter } from '../types.js';
export declare const linkupAdapter: ProviderAdapter;
