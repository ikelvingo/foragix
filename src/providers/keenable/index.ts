/**
 * Keenable search and page-fetch adapter.
 *
 * API facts verified against https://docs.keenable.ai/api-reference:
 * - Search: POST /v1/search with `query` and optional `max_results` (1–50), X-API-Key auth.
 * - Fetch: GET /v1/fetch?url=..., returning Markdown content.
 * - Search and indexed fetch each count as one request against 100,000 free requests/month.
 *   Purchased credits are controlled by the Keenable account; this adapter does not impose a local cap.
 * - 402 means monthly allowance spent with no credits; 401/403 are credential errors; 429 is rate limiting.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { clampCooldown, classifyParseFailure, parseRetryAfter } from '../../errors/classify.js';
import { interpret, parseJson, request } from '../http.js';

const CREDENTIAL = 'KEENABLE_API_KEY';
const BASE_URL = 'https://api.keenable.ai';
const MAX_RESULTS = 50;

interface KeenableSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
  }>;
}

interface KeenableFetchResponse {
  url?: string;
  title?: string;
  content?: string;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error(`${CREDENTIAL} is missing; the routing layer should have excluded this provider`);
  return { 'X-API-Key': key };
}

function classifyResponse(
  result: { status: number; headers: Readonly<Record<string, string>>; body: string },
  ctx: AdapterContext,
): ReturnType<typeof interpret> {
  // Keenable documents every 429 as a short-window rate limit. The generic body matcher sees
  // the word "exceeded" in "rate limit exceeded" and can misclassify it as monthly quota.
  if (result.status === 429) {
    const retryAfter = parseRetryAfter(result.headers['retry-after'] ?? null, ctx.now());
    return {
      kind: 'rate_limited_short',
      evidence: 'HTTP 429 Keenable rate limit',
      ...(retryAfter === null ? {} : { cooldownMs: clampCooldown(retryAfter) }),
    };
  }
  return interpret(result, keenableAdapter.errorHints, ctx.now());
}

export const keenableAdapter: ProviderAdapter = {
  id: 'keenable',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'keenable',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  errorHints: {
    statusMap: {
      403: { kind: 'credential_rejected', evidence: 'HTTP 403 Keenable API key disabled or revoked' },
    },
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 100_000,
      unit: 'requests',
      // The API specifies a monthly reset but no timezone; UTC is the local accounting convention.
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
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(maxResults === undefined ? {} : { max_results: maxResults }),
      },
    });
    if (!result.ok) return result;

    const verdict = classifyResponse(result.data, ctx);
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<KeenableSearchResponse>(result.data.body);
    if (parsed === null || !Array.isArray(parsed.results)) {
      return { ok: false, classification: classifyParseFailure('keenable search body is not a results array') };
    }

    const hits: SearchHit[] = parsed.results
      .filter((item): item is typeof item & { url: string } => typeof item?.url === 'string')
      .map((item) => ({
        title: item.title ?? '',
        url: item.url,
        ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
      }));
    return { ok: true, data: hits, usage: 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const url = new URL(`${BASE_URL}/v1/fetch`);
    url.searchParams.set('url', req.url);
    const result = await request(ctx.fetchImpl, url.toString(), {
      method: 'GET',
      headers: authHeaders(ctx),
    });
    if (!result.ok) return result;

    const verdict = classifyResponse(result.data, ctx);
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<KeenableFetchResponse>(result.data.body);
    if (parsed === null || typeof parsed.url !== 'string' || typeof parsed.content !== 'string') {
      return { ok: false, classification: classifyParseFailure('keenable fetch body is missing url or content') };
    }
    return {
      ok: true,
      data: {
        url: parsed.url,
        ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
        content: parsed.content,
      },
      usage: 1,
    };
  },
};
