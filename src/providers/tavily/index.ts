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
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const ENDPOINT_SEARCH = 'https://api.tavily.com/search';
const ENDPOINT_EXTRACT = 'https://api.tavily.com/extract';

const CREDENTIAL = 'TAVILY_API_KEY';

/**
 * The request shape is **hardcoded** by the adapter and not exposed to configuration.
 * `account` only participates in local preset derivation: it does not enter the request body and
 * does not change request parameters.
 */
const SEARCH_DEPTH = 'basic' as const;

/** Credits per request at the hardcoded `basic` search_depth (`advanced` would cost 2). */
const CREDITS_PER_SEARCH = 1;
/** Extract is conservatively counted as 1 credit/call (officially 1 credit per 5 successful URLs). */
const CREDITS_PER_EXTRACT = 1;

interface TavilySearchResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string; title?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  // Missing credentials should not reach here — the routing layer already excludes on bit 2. Defensive anyway, so `undefined` is never interpolated into the request headers.
  if (key === null) throw new Error('TAVILY_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const tavilyAdapter: ProviderAdapter = {
  id: 'tavily',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'tavily',
    requiresCredentials: true,
    // Canonical credential name. Exactly this name must be written in the config — the adapter reads by fixed name and accepts no aliases.
    credentialNames: [CREDENTIAL],
    // The request shape is hardcoded, so there are no account tier options.
    accountOptions: {},
  },

  errorHints: {
    // 429 is ambiguous: over-limit and exhausted monthly quota both return it, so the response body
    // distinguishes them.
  },

  init(account): ProviderInit {
    return {
      version: 1,
      canCharge: false,
      // Official: 1,000 credits/month, reset monthly
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 1_000,
      unit: 'credits',
      resetTimezone: 'UTC',
    };
  },

  usageOf(capability): number {
    return capability === 'search' ? CREDITS_PER_SEARCH : CREDITS_PER_EXTRACT;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        search_depth: SEARCH_DEPTH,
        ...(req.maxResults === undefined ? {} : { max_results: req.maxResults }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<TavilySearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('tavily search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { title?: string; url?: string; content?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? r.url ?? '',
        url: r.url as string,
        ...(r.content === undefined ? {} : { snippet: r.content }),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, ENDPOINT_EXTRACT, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { urls: [req.url] },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<TavilyExtractResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('tavily extract body is not JSON') };

    const first = parsed.results?.[0];
    if (first === undefined || typeof first.raw_content !== 'string') {
      // A 2xx with no body is not a transport failure but is of no value to the caller, so it is surfaced as our problem (no flag set).
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `tavily extract returned no content (failed_results=${parsed.failed_results?.length ?? 0})`,
        },
      };
    }

    return {
      ok: true,
      data: {
        url: first.url ?? req.url,
        ...(first.title === undefined ? {} : { title: first.title }),
        content: first.raw_content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
