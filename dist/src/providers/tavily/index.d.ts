/**
 * Tavily adapter.
 *
 * Facts below were read from the vendor's own documentation on 2026-10-28; re-verify before
 * changing billing behaviour. Anything marked "unverified" was not confirmed.
 *
 *  - Free quota 1,000 credits/month, no bank card required.
 *  - Credits: Basic Search 1/request, Advanced 2; Basic Extract 1 per 5 successful URLs, Advanced 2 per 5.
 *  - Over the limit: HTTP 429 with `Retry-After` — a hard stop, no automatic switch to paid.
 *  - Rate limits: 100 RPM on a dev key, 1,000 RPM on a prod key.
 *  - Unverified: the exact calendar date/time of the monthly reset.
 *
 * `can_charge` is false: no card is required and exceeding the limit returns 429 rather than charging.
 */
import type { ProviderAdapter } from '../types.js';
export declare const tavilyAdapter: ProviderAdapter;
