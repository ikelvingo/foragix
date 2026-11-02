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
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { bodySuggestsQuota, classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

const CREDENTIAL = 'BAIDU_API_KEY';
const ENDPOINT_SEARCH = 'https://qianfan.baidubce.com/v2/ai_search';
const MAX_COUNT = 50;

interface BaiduReference {
  id?: number;
  url?: string;
  title?: string;
  content?: string;
  date?: string;
}

interface BaiduSearchResponse {
  error_code?: number;
  error_msg?: string;
  request_id?: string;
  references?: Array<BaiduReference>;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('BAIDU_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const baiduAdapter: ProviderAdapter = {
  id: 'baidu',
  capabilities: ['search'],

  schema: {
    id: 'baidu',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'day',
      dayLimit: 100,
      monthLimit: null,
      unit: 'calls',
      // The reset timezone is undocumented; a CN-hosted daily quota is pinned to Beijing time.
      resetTimezone: 'Asia/Shanghai',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    // Live-probe contract (2026-11-02): the plain {"query"} body is rejected with
    // InvalidArgument "empty messages" — the working body is {"messages":[{role, content}]},
    // answered with {request_id, references[].count is not part of the verified shape.
    const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { messages: [{ role: 'user', content: req.query }] },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<BaiduSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('baidu search body is not JSON') };
    if (typeof parsed.error_code === 'number' && parsed.error_code !== 0) {
      // The official doc: the daily free-quota exhaustion of this product surfaces through
      // this envelope (a quota/limit error, not HTTP 402). Quota-semantics text therefore
      // means a day-period quota event; provider text stays redacted in every branch.
      if (bodySuggestsQuota(result.data.body)) {
        return {
          ok: false,
          classification: {
            kind: 'quota',
            period: 'day',
            evidence: `baidu error envelope code=${parsed.error_code} with quota semantics`,
          },
        };
      }
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `baidu error envelope code=${parsed.error_code} (${redact(parsed.error_msg ?? 'no message', 80)})`,
        },
      };
    }

    const refs = parsed.references;
    if (!Array.isArray(refs)) {
      // The response shape is live-verified; a 200 outside it is refused loudly.
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'baidu search response does not match the verified references[] shape',
        },
      };
    }

    const hits: SearchHit[] = refs
      .filter((r): r is BaiduReference & { url: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url,
        // `content` is the sourced extracts; `date` carries the publish timestamp when present.
        ...(typeof r.content === 'string' && r.content !== '' ? { snippet: r.content } : typeof r.date === 'string' ? { snippet: r.date } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
