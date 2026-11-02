/**
 * DeepSeek adapter (Search & Fetch tools API).
 *
 * Facts below were verified 2026-11-02 against api-docs.deepseek.com/guides/search and the
 * official pricing page (documents/providers/deepseek.md).
 *
 *  - Endpoints: `POST /v1/tools/search` and `POST /v1/tools/fetch`, Bearer-auth.
 *  - Search body: `query` (required, 1–128 chars), optional `count` 1–50 (default 10 —
 *    `maxResults` maps onto it); `need_content` stays false (page content belongs to fetch).
 *  - Fetch body: `{url}`; response `{title, content}` with content as Markdown.
 *  - Billing: every successful request is billable at $0.75/1,000 (live since 2026-11-01);
 *    there is no periodic free quota, so the adapter declares `quotaPeriod 'none'` — a
 *    balance exhaustion bit clears only through an external event (top-up is outside the
 *    engine's control). `canCharge` is true: the paid gate applies by default.
 *  - Verified error semantics: 402 = balance exhausted (quota), 401 = key rejected,
 *    429 = account/per-domain QPS exceeded (short window), 404 (fetch only) = no usable
 *    page content — refused by the site, not a transport failure, so "our problem".
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'DEEPSEEK_API_KEY';
const BASE_URL = 'https://api.deepseek.com';
const MAX_COUNT = 50;

interface DeepseekSearchResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string; summary?: string }>;
}

interface DeepseekFetchResponse {
  title?: string;
  content?: string;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('DEEPSEEK_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const deepseekAdapter: ProviderAdapter = {
  id: 'deepseek',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'deepseek',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  errorHints: {
    // Verified per the official error table: fetch 404 means "no usable page content"
    // (site policy / unsupported content type), not a transport failure — no flags, next provider.
    // 403 on fetch is a security-policy rejection — the same treatment.
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      // Per-request billing; no free-tier quota and no vendor reset window to track.
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'successful-requests',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/tools/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        need_content: false,
        ...(count === undefined ? {} : { count }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<DeepseekSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('deepseek search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { title?: string; url?: string; snippet?: string; summary?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        // `summary` is the model-facing text; fall back to `snippet`.
        ...(typeof r.summary === 'string' && r.summary !== '' ? { snippet: r.summary } : typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/tools/fetch`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<DeepseekFetchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('deepseek fetch body is not JSON') };

    if (typeof parsed.content !== 'string') {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'deepseek fetch returned no content field in a 2xx response',
        },
      };
    }

    return {
      ok: true,
      data: {
        url: req.url,
        ...(typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {}),
        content: parsed.content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
