/**
 * TinyFish adapter (TinySearch + TinyFetch).
 *
 * Facts below were verified 2026-11-02 against docs.tinyfish.ai, replacing the
 * 2026-10-28 "quota attribution undecided" verdict once the actual shape was known
 * (documents/providers/tinyfish.md).
 *
 *  - Two hosts, two capabilities: `GET https://api.search.tinyfish.ai?query=…` and
 *    `POST https://api.fetch.tinyfish.ai` (`{urls, format}`, one URL per call here),
 *    auth `X-API-Key: $TINYFISH_API_KEY`.
 *  - Search response: `{results: [{title, snippet, url, …}]}`; no documented count/limit
 *    parameter (the "500 req/hour" figure of the earlier assessment appears nowhere
 *    official — the verified per-minute limits are 30 search/min and 150 URL/min).
 *  - Fetch response keeps HTTP 200 and carries per-URL failures inside
 *    `{results: [], errors: [{url, error, …}]}` — a body-level error list is "our
 *    problem" (site refusal), not a transport failure.
 *  - Quota: daily free allowances (12k search/day, 1k fetch URLs/day) resetting at
 *    00:00 UTC; beyond them, a positive prepaid wallet is billed, so `canCharge` is
 *    true and the paid gate applies by default. The two allowances differ per
 *    capability, which the single provider-level dayLimit cannot represent — so
 *    both `dayLimit` stays null (not locally countable) and the day-quota bit is set
 *    only by the verified 402 availability signs (FREE_ALLOWANCE_EXHAUSTED /
 *    INSUFFICIENT_CREDITS, both daily-reset).
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'TINYFISH_API_KEY';
const SEARCH_URL = 'https://api.search.tinyfish.ai';
const FETCH_URL = 'https://api.fetch.tinyfish.ai';

interface TinyfishSearchResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
}

interface TinyfishFetchResponse {
  results?: Array<{ url?: string; title?: string; text?: string }>;
  errors?: Array<{ url?: string; error?: string; status?: number }>;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('TINYFISH_API_KEY is missing; the routing layer should have excluded this provider');
  return { 'x-api-key': key };
}

export const tinyfishAdapter: ProviderAdapter = {
  id: 'tinyfish',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'tinyfish',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  // Verified availability signs arrive only as HTTP 402 with a body code, so no hints are
  // needed: the status path plus the day declaration carry the semantics.
  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'day',
      // Per-capability daily allowances (12k search / 1k fetch) are not representable as
      // one provider-level limit, so local counting is disabled.
      dayLimit: null,
      monthLimit: null,
      unit: 'requests+urls',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', req.query);
    if (req.maxResults !== undefined) {
      // Deliberately ignored: no documented count/limit parameter exists.
    }

    const result = await request(ctx.fetchImpl, url.toString(), {
      method: 'GET',
      headers: authHeaders(ctx),
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<TinyfishSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('tinyfish search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { title?: string; url?: string; snippet?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, FETCH_URL, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { urls: [req.url], format: 'markdown' },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<TinyfishFetchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('tinyfish fetch body is not JSON') };

    const first = (parsed.results ?? []).find((r) => typeof r?.text === 'string');
    if (first === undefined) {
      const failure = parsed.errors?.[0];
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `tinyfish fetch reported no usable content${failure === undefined ? '' : ` (${failure.error})`}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        url: typeof first.url === 'string' ? first.url : req.url,
        ...(typeof first.title === 'string' && first.title !== '' ? { title: first.title } : {}),
        content: first.text as string,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
