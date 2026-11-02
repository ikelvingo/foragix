/**
 * Baidu AI Search adapter (Qianfan v2 gateway).
 *
 * Facts below were verified 2026-11-02; the primary official REST reference page sits behind
 * the console login, so request/response field names rest on the official community topic and
 * integration write-ups cross-checked in documents/providers/baidu.md — flagged as the
 * provider's weakest schema evidence and re-verifiable only with a console session.
 *
 *  - Search-only: `POST https://qianfan.baidubce.com/v2/ai_search` Bearer-auth; the
 *    chat/completions variant (answer synthesis) is out of scope for result retrieval.
 *  - Body (verified): `{"messages":[{"role":"user","content":"<query>"}]}` — the older `{query, count}`
 *    shape is rejected live with "empty messages". The 100/day quota belongs to this AI Search
 *    service; a second plain-search product with a separate 50/day allowance is out of scope.
 *  - Response shape (live-verified 2026-11-02): `{request_id, references[]}` with `id`/`url`/`title`/
 *    `content`/`date`; a 200 outside it fails loudly ("our problem") instead of silently
 *    reporting an empty success.
 *  - Quota: 100 free calls/day, then usage-based billing — `canCharge` true, the paid gate
 *    applies by default. Daily reset assumed at Beijing time (documented gap).
 *  - Qianfan v2 failures carry `{error_code, error_msg}` on 2xx responses; when the envelope
 *    text carries quota semantics (the documented daily-exhaustion path) it is a day-period
 *    quota event, and anything else stays unverified (provider text is redacted).
 */
import type { ProviderAdapter } from '../types.js';
export declare const baiduAdapter: ProviderAdapter;
