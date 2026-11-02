/**
 * Ollama cloud search adapter.
 *
 * Facts below were verified 2026-11-02 (live probes + official docs; see
 * documents/providers/ollama.md).
 *
 *  - Search: `POST https://api.ollama.com/api/web_search` Bearer auth, body `{query}`,
 *    response `{results: [{title, url, content}]}`.
 *  - Fetch: `POST /api/web_fetch`, body `{url}`, response `{title, content}` (Markdown).
 *  - Billing: the web-tool APIs are free-tier APIs of the ollama cloud account — no per-call
 *    charge is documented on the current pages, so `canCharge` is false; if the vendor
 *    introduces pricing, the adapter version must be bumped.
 *  - Quota: no locally countable, vendor-declared reset window is published for these
 *    endpoints (`quotaPeriod 'none'`).
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'OLLAMA_API_KEY';
const BASE_URL = 'https://api.ollama.com/api';

interface OllamaSearchResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface OllamaFetchResponse {
  title?: string;
  content?: string;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('OLLAMA_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const ollamaAdapter: ProviderAdapter = {
  id: 'ollama',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'ollama',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: false,
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'requests',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    // Officially documented: `max_results` defaults to 5, max 10 — mapping `maxResults`
    // tightens the response so the caller pays for only the results it needs.
    const maxResults = req.maxResults === undefined ? undefined : Math.min(10, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${BASE_URL}/web_search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(maxResults === undefined ? {} : { max_results: maxResults }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<OllamaSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('ollama search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { title?: string; url?: string; content?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.content === 'string' ? { snippet: r.content } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/web_fetch`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<OllamaFetchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('ollama fetch body is not JSON') };

    if (typeof parsed.content !== 'string') {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'ollama fetch returned no content field in a 2xx response',
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
