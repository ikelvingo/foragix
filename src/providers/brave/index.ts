/**
 * Brave Search adapter.
 *
 * Facts below were verified 2026-11-02 against api-dashboard.search.brave.com official pages
 * (see documents/providers/brave.md).
 *
 *  - Search-only: the Search API publishes no page-content fetch endpoint
 *    (`include_fetch_metadata` returns metadata about search results, not page content).
 *  - Request: `GET /res/v1/web/search` with `X-Subscription-Token`; only `q` and `count` are sent
 *    (the request shape is hardcoded; `count` maps `maxResults`, clamped to the 1–20 API range).
 *  - Success response: `web.results[]` with `title`/`url`/`description`.
 *  - Rate limiting: 429 on exceed; every response carries `X-RateLimit-Remaining` with two CSV
 *    values (per-second window, monthly window) and `X-RateLimit-Reset` in seconds. The 429 body
 *    shape is undocumented, so the header pair is the only verified signal that separates
 *    a short-window denial from **monthly quota exhaustion**; when the monthly remaining value
 *    is 0 the response is classified as monthly quota exhaustion instead of cooldown.
 *  - Quota: $5 credits auto-applied monthly ≈ 1,000 requests at the Search rate ($5.00 per
 *    1,000 requests); only successful requests count. Usage beyond the free credits is
 *    billable, so `canCharge` is true and the paid gate applies (default off).
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'BRAVE_API_KEY';
const ENDPOINT_SEARCH = 'https://api.search.brave.com/res/v1/web/search';
const MAX_COUNT = 20;

interface BraveSearchResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('BRAVE_API_KEY is missing; the routing layer should have excluded this provider');
  return { 'x-subscription-token': key };
}

/** The monthly window is the second CSV value of `X-RateLimit-Remaining`; null when absent. */
function monthlyRemaining(headers: Readonly<Record<string, string>> | undefined): number | null {
  const raw = headers?.['x-ratelimit-remaining'];
  if (raw === undefined) return null;
  const values = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value));
  return values.length > 0 ? values[values.length - 1]! : null;
}

export const braveAdapter: ProviderAdapter = {
  id: 'brave',
  capabilities: ['search'],

  schema: {
    id: 'brave',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'month',
      dayLimit: null,
      // ≈ the $5 monthly credits at the Search rate; the vendor grants credits, not a request count.
      monthLimit: 1_000,
      unit: 'requests',
      // The monthly reset calendar boundary is not documented; UTC is the explicit approximation.
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const url = new URL(ENDPOINT_SEARCH);
    url.searchParams.set('q', req.query);
    if (count !== undefined) url.searchParams.set('count', String(count));

    const result = await request(ctx.fetchImpl, url.toString(), {
      method: 'GET',
      headers: authHeaders(ctx),
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind === 'rate_limited_short') {
      // Verified header semantics: the monthly CSV value reaching 0 means the monthly window is
      // exhausted — a persistent quota bit, not a once-per-second cooldown.
      if (monthlyRemaining(result.data.headers) === 0) {
        return {
          ok: false,
          classification: {
            kind: 'quota',
            period: 'month',
            evidence: 'brave rate-limit header shows the monthly window at 0 remaining',
          },
        };
      }
      return { ok: false, classification: verdict };
    }
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<BraveSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('brave search body is not JSON') };

    const hits: SearchHit[] = (parsed.web?.results ?? [])
      .filter((r): r is { title?: string; url?: string; description?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.description === 'string' ? { snippet: r.description } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
