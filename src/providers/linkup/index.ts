/**
 * LinkUp adapter.
 *
 * Facts below were verified 2026-11-02 (live probes + official docs where reachable;
 * see documents/providers/linkup.md).
 *
 *  - Search: `POST https://api.linkup.so/v1/search`, Bearer auth. The verified body is
 *    `{"q": …, "depth": "standard", "outputType": "searchResults", "includeImages": false}`
 *    — the request shape is hardcoded; `outputType: sourcedAnswer` would spend extra budget
 *    on answer synthesis, which is not what a Search hop is for.
 *  - Fetch: `POST /v1/fetch` with `{url}`; response `content`/`title`.
 *  - Billing: prepaid account credits — `canCharge` true (paid gate applies by default),
 *    credit-based spend without a vendor reset window → `quotaPeriod 'none'`.
 *  - Verified error semantics: validation failures answer 400 with a
 *    `{error:{code:"VALIDATION_ERROR",details[]}}` envelope (our problem); 401 key rejected.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

const CREDENTIAL = 'LINKUP_API_KEY';
const BASE_URL = 'https://api.linkup.so';

interface LinkupSearchItem {
  name?: string;
  title?: string;
  url?: string;
  content?: string;
  text?: string;
}

interface LinkupSearchResponse {
  results?: LinkupSearchItem[];
}

interface LinkupFetchResponse {
  title?: string;
  content?: string;
  text?: string;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('LINKUP_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const linkupAdapter: ProviderAdapter = {
  id: 'linkup',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'linkup',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
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
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        q: req.query,
        depth: 'standard',
        outputType: 'searchResults',
        includeImages: false,
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<LinkupSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('linkup search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is LinkupSearchItem => typeof r?.url === 'string')
      .map((r) => ({
        title: r.name ?? r.title ?? '',
        url: r.url as string,
        ...(typeof r.content === 'string' && r.content !== '' ? { snippet: r.content } : typeof r.text === 'string' ? { snippet: r.text } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/fetch`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<LinkupFetchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('linkup fetch body is not JSON') };

    const content = typeof parsed.content === 'string' ? parsed.content : typeof parsed.text === 'string' ? parsed.text : undefined;
    if (content === undefined || content === '') {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'linkup fetch returned no content in a 2xx response',
        },
      };
    }

    return {
      ok: true,
      data: {
        url: req.url,
        ...(typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {}),
        content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
