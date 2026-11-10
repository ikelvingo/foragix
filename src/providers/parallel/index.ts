/**
 * Parallel adapter.
 *
 * Facts below were verified 2026-11-10 against the official OpenAPI document plus live probes.
 *
 *  - Search: `POST https://api.parallel.ai/v1/search` with header `x-api-key`. The verified
 *    body carries `search_queries` (required) and `objective`; `mode` is hardcoded to `fast`
 *    because the vendor default is `advanced`, which costs five times as much.
 *  - Fetch: `POST /v1/extract` with `urls: [url]` and `advanced_settings.full_content: true`;
 *    the response carries `full_content` (markdown) plus `errors[]` for URLs that failed.
 *  - Quota: a $5 monthly credit for organizations with a credit card; non-accumulating and
 *    expiring at month end. At the `fast` search rate and the extract rate that is roughly
 *    5,000 requests, so the local ceiling is diagnostic rather than an enforced budget.
 *  - Verified errors: 401 invalid key (`{code:16,...}`), 402 insufficient credit, 422 request
 *    validation, 429 short-window rate limit. Parallel words its 429 body with "quota", so the
 *    short window is pinned by status code before the generic body matcher can see it.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { clampCooldown, classifyParseFailure, parseRetryAfter } from '../../errors/classify.js';
import { interpret, parseJson, request } from '../http.js';

const CREDENTIAL = 'PARALLEL_API_KEY';
const BASE_URL = 'https://api.parallel.ai';
const MAX_RESULTS = 100;
/** The vendor's cheap synchronous preset; `advanced` is the costly server-side default. */
const MODE = 'fast';

interface ParallelSearchResult {
  url?: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: unknown;
}

interface ParallelSearchResponse {
  results?: ParallelSearchResult[];
}

interface ParallelExtractResult {
  url?: string;
  title?: string | null;
  excerpts?: unknown;
  full_content?: string | null;
}

interface ParallelExtractError {
  url?: string;
  error_type?: string;
  http_status_code?: number | null;
}

interface ParallelExtractResponse {
  results?: ParallelExtractResult[];
  errors?: ParallelExtractError[];
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error(`${CREDENTIAL} is missing; the routing layer should have excluded this provider`);
  return { 'x-api-key': key };
}

/** Joins the excerpt array the API returns; a missing or non-array value yields no snippet. */
function snippetOf(excerpts: unknown): string | undefined {
  if (!Array.isArray(excerpts)) return undefined;
  const parts = excerpts.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** A 429 here is always the documented per-minute window, even though its body says "quota". */
function classifyResponse(
  result: { status: number; headers: Readonly<Record<string, string>>; body: string },
  ctx: AdapterContext,
): ReturnType<typeof interpret> {
  if (result.status === 429) {
    const retryAfter = parseRetryAfter(result.headers['retry-after'] ?? null, ctx.now());
    return {
      kind: 'rate_limited_short',
      evidence: 'HTTP 429 Parallel rate limit',
      ...(retryAfter === null ? {} : { cooldownMs: clampCooldown(retryAfter) }),
    };
  }
  return interpret(result, parallelAdapter.errorHints, ctx.now());
}

export const parallelAdapter: ProviderAdapter = {
  id: 'parallel',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'parallel',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  errorHints: {
    statusMap: {
      401: { kind: 'credential_rejected', evidence: 'HTTP 401 Parallel API key rejected' },
      402: { kind: 'quota', period: 'month', evidence: 'HTTP 402 Parallel credit exhausted' },
      422: { kind: 'our_problem', evidence: 'HTTP 422 Parallel request validation error' },
    },
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'month',
      dayLimit: null,
      // ≈ the $5 monthly credit at the fast/extract rate; the vendor grants credit, not a count.
      monthLimit: 5_000,
      unit: 'requests',
      // The monthly reset timezone is undocumented; UTC is the explicit accounting convention.
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const maxResults = req.maxResults === undefined
      ? undefined
      : Math.min(MAX_RESULTS, Math.max(1, req.maxResults));
    // The routing layer appends " site:zhihu.com" for non-Zhihu adapters; the native domain
    // filter below carries the same restriction without polluting the keyword query.
    const query = req.site === 'zhihu'
      ? req.query.replace(/(?:^|\s)site:zhihu\.com(?=\s|$)/gi, ' ').trim()
      : req.query;
    const advancedSettings = {
      ...(maxResults === undefined ? {} : { max_results: maxResults }),
      ...(req.site === 'zhihu' ? { source_policy: { include_domains: ['zhihu.com'] } } : {}),
    };

    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        objective: query,
        search_queries: [query],
        mode: MODE,
        ...(Object.keys(advancedSettings).length === 0 ? {} : { advanced_settings: advancedSettings }),
      },
    });
    if (!result.ok) return result;

    const verdict = classifyResponse(result.data, ctx);
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<ParallelSearchResponse>(result.data.body);
    if (parsed === null || !Array.isArray(parsed.results)) {
      return { ok: false, classification: classifyParseFailure('parallel search body is not a results array') };
    }

    const hits: SearchHit[] = parsed.results
      .filter((item): item is ParallelSearchResult & { url: string } => typeof item?.url === 'string')
      .map((item) => {
        const snippet = snippetOf(item.excerpts);
        return {
          title: typeof item.title === 'string' && item.title !== '' ? item.title : item.url,
          url: item.url,
          ...(snippet === undefined ? {} : { snippet }),
        };
      });

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/extract`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        urls: [req.url],
        advanced_settings: { full_content: true },
      },
    });
    if (!result.ok) return result;

    const verdict = classifyResponse(result.data, ctx);
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<ParallelExtractResponse>(result.data.body);
    if (parsed === null || !Array.isArray(parsed.results)) {
      return { ok: false, classification: classifyParseFailure('parallel extract body is not a results array') };
    }

    const first = parsed.results[0];
    const content = typeof first?.full_content === 'string' && first.full_content !== ''
      ? first.full_content
      : first === undefined
        ? undefined
        : snippetOf(first.excerpts);
    if (content === undefined) {
      const failed = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
      const detail = typeof failed?.error_type === 'string' ? ` (${failed.error_type})` : '';
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `parallel extract returned no content for the requested page${detail}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        url: req.url,
        ...(typeof first?.title === 'string' && first.title !== '' ? { title: first.title } : {}),
        content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
