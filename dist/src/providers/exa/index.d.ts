/**
 * Exa adapter.
 *
 * Facts below were read from the vendor's own documentation on 2026-10-28; re-verify before
 * changing billing behaviour. Anything marked "unverified" was not confirmed.
 *
 *  - Quota is a USD balance, not a request count: $10/month, resets on the first of the calendar
 *    month, unused balance does not accumulate.
 *  - Rates differ per endpoint and content type.
 *  - An exhausted balance returns HTTP 402.
 *  - Rate limits: 10 QPS default, 100 QPS for `/contents`, 5 QPS for deep types.
 *  - Unverified: the default state of auto-recharge.
 *
 * The balance cannot be counted locally, so `dayLimit` and `monthLimit` are null while
 * `quotaPeriod` is `'month'`; the vendor's 402 is the safety net.
 * `can_charge` is true because auto-recharge cannot be ruled out.
 */
import type { ProviderAdapter } from '../types.js';
export declare const exaAdapter: ProviderAdapter;
