/**
 * Firecrawl adapter (v2 search + scrape).
 *
 * Facts below were verified 2026-11-02 against docs.firecrawl.dev and the official pricing
 * page (documents/providers/firecrawl.md).
 *
 *  - Search: `POST /v2/search` with `{query, limit}` (limit 1–100, default 10); response
 *    `data.web[]` with `title`/`description`/`url`. `scrapeOptions` is NOT sent: in-page
 *    content extraction belongs to fetch, and mixing it here would burn extra credits.
 *  - Fetch: `POST /v2/scrape` with `{url}`; response `data` with `markdown`/`html`/`rawHtml`
 *    and `metadata{title, sourceURL}`. Content preference: markdown → html → rawHtml.
 *  - Billing: `credits` — search costs 2 credits per call (the default request of 10 results;
 *    billed per 10-result block), scrape 1 credit/page; one shared balance. Free tier is
 *    1,000 credits/month, refreshed monthly; beyond that PAYG in $5 increments is available,
 *    so usage is billable and `canCharge` is true (the paid gate applies by default).
 *  - Verified error semantics: 402 = credit exhaustion (quota, monthly), 401 = key rejected,
 *    403 = plan/scope/site unsupported (our problem — not auth, since keyed access failures
 *    return 401), 429 carries `Retry-After` in seconds when available.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'FIRECRAWL_API_KEY';
const BASE_URL = 'https://api.firecrawl.dev';
const MAX_LIMIT = 100;

interface FirecrawlItem {
  title?: string;
  description?: string;
  url?: string;
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: { web?: FirecrawlItem[] };
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    title?: string;
    metadata?: { title?: string; sourceURL?: string };
  };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('FIRECRAWL_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const firecrawlAdapter: ProviderAdapter = {
  id: 'firecrawl',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'firecrawl',
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
      monthLimit: 1_000,
      unit: 'credits',
      resetTimezone: 'UTC',
    };
  },

  /** Search is billed per 10-result block (2 credits); scrape 1 credit per page. */
  usageOf(capability): number {
    return capability === 'search' ? 2 : 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const limit = req.maxResults === undefined ? undefined : Math.min(MAX_LIMIT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v2/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(limit === undefined ? {} : { limit }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<FirecrawlSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('firecrawl search body is not JSON') };

    const hits: SearchHit[] = (parsed.data?.web ?? [])
      .filter((r): r is FirecrawlItem => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.description === 'string' ? { snippet: r.description } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 2 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v2/scrape`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<FirecrawlScrapeResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('firecrawl scrape body is not JSON') };

    const data = parsed.data ?? {};
    // Content preference per the documented format priority; all three fields are optional.
    const content =
      typeof data.markdown === 'string' ? data.markdown : typeof data.html === 'string' ? data.html : typeof data.rawHtml === 'string' ? data.rawHtml : undefined;
    if (content === undefined || content === '') {
      // 404-class responses (no usable content) arrive as HTTP 404 and are classified by the
      // verified status catalog; a 2xx without content is of no value to the caller.
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'firecrawl scrape returned no content in a 2xx response',
        },
      };
    }

    const title = typeof data.metadata?.title === 'string' ? data.metadata.title : typeof data.title === 'string' ? data.title : undefined;
    const url = typeof data.metadata?.sourceURL === 'string' && data.metadata.sourceURL !== '' ? data.metadata.sourceURL : req.url;

    return {
      ok: true,
      data: { url, content, ...(title === undefined ? {} : { title }) },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
