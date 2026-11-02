/**
 * Zhihu data open-platform adapter.
 *
 * Facts below were verified 2026-11-02 against developer.zhihu.com docs and the platform's
 * own HTTP reference (see documents/providers/zhihu.md).
 *
 *  - Search-only: `GET /api/v1/content/zhihu_search` and `GET /api/v1/content/global_search`,
 *    chosen by the account option `db`. Auth: `Authorization: Bearer <access secret>` plus a
 *    `X-Request-Timestamp` header with the current unix time in seconds.
 *  - Query params: `Query` (required), `Count` (1–20 — `maxResults` clamped), `SearchDB`
 *    (global only), `Filter` grammar is not exposed by this adapter (hardcoded request shape).
 *  - Response: `{Code, Message, Data: {HasMore, Items[]}}`; Items carry `Title`, `Url`,
 *    `ContentText` (highlights wrapped in <em> — stripped here for a clean snippet), plus
 *    author/authority metadata. Pagination via `HasMore` is not followed by this adapter:
 *    a search call answers what the vendor returned for the count sent.
 *  - Quota: invited-test terms — 5,000 calls/day per search capability and nothing beyond a
 *    bespoke business plan (not yet chargeable), so `canCharge` is false; declared as a
 *    day-period quota with a 5,000/day ceiling.
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

const CREDENTIAL = 'ZHIHU_API_KEY';
const BASE_URL = 'https://developer.zhihu.com/api/v1/content';
const MAX_COUNT = 20;

interface ZhihuItem {
  Title?: string;
  ContentType?: string;
  ContentID?: string;
  ContentText?: string;
  Url?: string;
  AuthorityLevel?: string;
}

interface ZhihuResponse {
  Code?: number;
  Message?: string;
  Data?: { HasMore?: boolean; Items?: ZhihuItem[] };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('ZHIHU_API_KEY is missing; the routing layer should have excluded this provider');
  // The platform verifies a per-request unix-seconds timestamp alongside the secret.
  return { authorization: `Bearer ${key}`, 'x-request-timestamp': String(Math.floor(ctx.now() / 1000)) };
}

export const zhihuAdapter: ProviderAdapter = {
  id: 'zhihu',
  capabilities: ['search'],

  schema: {
    id: 'zhihu',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {
      db: {
        type: 'string',
        allowedValues: ['zhihu', 'global'],
        default: 'zhihu',
        description: 'zhihu = 知乎站内搜索接口; global = 全网搜索接口 (SearchDB=realtime|static|all)',
      },
    },
  },

  init(_account): ProviderInit {
    const raw = _account['db'];
    const isGlobal = raw === 'global';
    return {
      version: 1,
      canCharge: false,
      quotaPeriod: 'day',
      dayLimit: 5_000,
      monthLimit: null,
      unit: 'calls',
      resetTimezone: 'UTC',
      ...(isGlobal ? {} : {}),
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const account = ctx.config.account;
    const kind = account['db'] === 'global' ? 'global_search' : 'zhihu_search';
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));

    const url = new URL(`${BASE_URL}/${kind}`);
    url.searchParams.set('Query', req.query);
    if (count !== undefined) url.searchParams.set('Count', String(count));
    if (kind === 'global_search') url.searchParams.set('SearchDB', 'all');

    const result = await request(ctx.fetchImpl, url.toString(), {
      method: 'GET',
      headers: authHeaders(ctx),
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<ZhihuResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('zhihu search body is not JSON') };

    if (typeof parsed.Code === 'number' && parsed.Code !== 0) {
      // Since the envelope arrives on HTTP 200, the hints cannot match it (a capitalized
      // Code key is not tested by the extractor); semantics are verified per-code.
      if (parsed.Code === 20001) {
        // Verified live: an authentication failure of the Access Secret.
        return {
          ok: false,
          classification: { kind: 'credential_rejected', evidence: 'zhihu envelope Code=20001 (access-secret rejected)' },
        };
      }
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `zhihu envelope Code=${parsed.Code} (${redact(parsed.Message ?? 'no message', 80)})`,
        },
      };
    }

    const hits: SearchHit[] = (parsed.Data?.Items ?? [])
      .filter((r): r is ZhihuItem & { Url: string } => typeof r?.Url === 'string')
      .map((r) => ({
        title: r.Title ?? '',
        url: r.Url,
        // <em> marks the query-hit highlights inside the vendor snippet; plain-text wins.
        ...(typeof r.ContentText === 'string' ? { snippet: r.ContentText.replaceAll(/<\/?em>/g, '') } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
