/**
 * AnySearch adapter.
 *
 * Facts below were verified 2026-11-02 against the vendor's own docs hub and pricing page,
 * superseding the earlier "unconfirmed" verdict of the 2026-10-28 assessment
 * (documents/providers/anysearch.md).
 *
 *  - Endpoints: `POST /v1/search` (`{query, max_results}` 1–10, no pagination) and
 *    `POST /v1/extract` (`{url}` strict single-field body) — search and fetch share one
 *    `/v1` quota pool. Bearer auth; `Content-Type: application/json` is enforced (415).
 *  - Success envelope: `{code: 0, message, data: {results|…}}`.
 *  - Verified error semantics: 402 = quota exhausted, 401/403 = key issues, 429 = QPS,
 *    415/422 = request construction (our problem), 502 = upstream unavailable (transient).
 *  - Quota: free plan 1,000 calls/day (10 QPS); Pro $3/1,000 calls is billable beyond it,
 *    so `canCharge` is true (the paid gate applies by default) and the daily reset is
 *    tracked as a day-period quota. The reset clock timezone is undocumented; UTC is the
 *    explicit approximation.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'ANYSEARCH_API_KEY';
const BASE_URL = 'https://api.anysearch.com';
const MAX_RESULTS = 10;

interface AnysearchEnvelope {
  code?: number;
  message?: string;
  data?: {
    results?: Array<{ title?: string; url?: string; snippet?: string; content?: string }>;
    url?: string;
    title?: string;
    content?: string;
  };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('ANYSEARCH_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const anysearchAdapter: ProviderAdapter = {
  id: 'anysearch',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'anysearch',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'day',
      dayLimit: 1_000,
      monthLimit: null,
      unit: 'calls',
      // The reset clock/timezone is undocumented; UTC is the explicit approximation.
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const max_results = req.maxResults === undefined ? undefined : Math.min(MAX_RESULTS, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(max_results === undefined ? {} : { max_results }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<AnysearchEnvelope>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('anysearch search body is not JSON') };
    if (parsed.code !== undefined && parsed.code !== 0) {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `anysearch envelope code=${parsed.code} on a 2xx response`,
        },
      };
    }

    const hits: SearchHit[] = (parsed.data?.results ?? [])
      .filter((r): r is { title?: string; url?: string; snippet?: string; content?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.snippet === 'string' && r.snippet !== '' ? { snippet: r.snippet } : typeof r.content === 'string' ? { snippet: r.content } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/extract`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<AnysearchEnvelope>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('anysearch extract body is not JSON') };
    if (parsed.code !== undefined && parsed.code !== 0) {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `anysearch envelope code=${parsed.code} on a 2xx response`,
        },
      };
    }

    if (typeof parsed.data?.content !== 'string') {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'anysearch extract returned no content field',
        },
      };
    }

    const title = typeof parsed.data.title === 'string' && parsed.data.title !== '' ? parsed.data.title : undefined;
    const url = typeof parsed.data.url === 'string' && parsed.data.url !== '' ? parsed.data.url : req.url;
    return {
      ok: true,
      data: { url, content: parsed.data.content, ...(title === undefined ? {} : { title }) },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
