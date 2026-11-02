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
 *  - Body: `{query, count}` (count = `maxResults`, clamped 1–50).
 *  - Response shape family: `webPages.value[]` with `title`/`url`/`summary` — treated as
 *    indicative; a 200 that matches none of the known shapes fails loudly ("our problem")
 *    instead of silently reporting an empty success.
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

interface BaiduItem {
  title?: string;
  url?: string;
  summary?: string;
}

interface BaiduSearchResponse {
  error_code?: number;
  error_msg?: string;
  webPages?: { value?: BaiduItem[] };
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
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(count === undefined ? {} : { count }),
      },
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

    const items = parsed.webPages?.value;
    if (!Array.isArray(items)) {
      // The response shape is the provider's weakest evidence; refuse loudly rather than
      // silently reporting an empty success against an unrecognized shape.
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'baidu search response does not match the documented webPages.value shape',
        },
      };
    }

    const hits: SearchHit[] = items
      .filter((r): r is BaiduItem => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.summary === 'string' ? { snippet: r.summary } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
