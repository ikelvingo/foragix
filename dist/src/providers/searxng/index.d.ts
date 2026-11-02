/**
 * SearXNG adapter (self-hosted instance).
 *
 * Facts below were verified 2026-11-02 against docs.searxng.org and a live probe of the
 * configured instance (documents/providers/searxng.md).
 *
 *  - No credential system: instance-side access control only, so the adapter requires no
 *    keys. The instance base URL is a config `account` option, defaulting to the owner's
 *    deployment `https://search.ikelvin.space:8443` (per the owner's instruction).
 *  - Search: `GET {base}/search?q=<query>&format=json`. The JSON format must be enabled
 *    instance-side (`search.formats`); a 403 then means "format disabled", not auth.
 *  - Success response: `results[]` with `url`/`title`/`content`; `unresponsive_engines[]`
 *    is the health signal — upstream CAPTCHA/denials produce 200 with degraded results.
 *  - A forged client IP (`X-Forwarded-For`) must NOT be sent: it breaks the limiter.
 *  - Self-hosted: no billing, no platform quota — `canCharge` false and no countable
 *    limits; upstream-engine pressure degrades results rather than failing HTTP-level.
 */
import type { ProviderAdapter } from '../types.js';
export declare const searxngAdapter: ProviderAdapter;
