/**
 * Exa adapter.
 *
 * Facts below were read from the vendor's own documentation on 2026-10-28; re-verify before
 * changing billing behaviour. Anything marked "unverified" was not confirmed.
 *
 *  - Quota is a USD balance, not a request count: $10/month, resets on the first of the calendar
 *    month, unused balance does not accumulate.
 *  - Rates differ per endpoint and content type.
 *  - An exhausted balance returns HTTP 402.
 *  - Rate limits: 10 QPS default, 100 QPS for `/contents`, 5 QPS for deep types.
 *  - Unverified: the default state of auto-recharge.
 *
 * The balance cannot be counted locally, so `dayLimit` and `monthLimit` are null while
 * `quotaPeriod` is `'month'`; the vendor's 402 is the safety net.
 * `can_charge` is true because auto-recharge cannot be ruled out.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const ENDPOINT_SEARCH = 'https://api.exa.ai/search';
const ENDPOINT_CONTENTS = 'https://api.exa.ai/contents';

const CREDENTIAL = 'EXA_API_KEY';

/** The request shape is hardcoded by the adapter and not exposed to configuration. */
const SEARCH_TYPE = 'auto' as const;

interface ExaSearchResponse {
  results?: Array<{ title?: string; url?: string; text?: string }>;
}

interface ExaContentsResponse {
  results?: Array<{ url?: string; title?: string; text?: string }>;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('EXA_API_KEY is missing; the routing layer should have excluded this provider');
  return { 'x-api-key': key };
}

export const exaAdapter: ProviderAdapter = {
  id: 'exa',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'exa',
    requiresCredentials: true,
    // Canonical credential name. Exactly this name must be written in the config — the adapter reads by fixed name and accepts no aliases.
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  errorHints: {
    // Officially confirmed: an exhausted balance returns 402.
    statusMap: {
      402: { kind: 'quota', period: null, evidence: 'Exa: officially confirmed that an exhausted balance returns 402' },
    },
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      // Auto-recharge default unverified → conservatively treated as chargeable.
      canCharge: true,
      // $10/month, resets on the first of the calendar month, unused balance does not accumulate.
      // The balance cannot be counted in requests, hence both limits are null.
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: null,
      unit: 'usd_credits',
      resetTimezone: 'UTC',
    };
  },

  // No usageOf: the quota is decremented in dollars and cannot be observed locally.
  // An absent usageOf means "cannot be counted", not "counts as one".

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        type: SEARCH_TYPE,
        ...(req.maxResults === undefined ? {} : { numResults: req.maxResults }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<ExaSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('exa search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { title?: string; url?: string; text?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? (r.url as string),
        url: r.url as string,
        ...(r.text === undefined ? {} : { snippet: r.text }),
      }));

    return { ok: true, data: hits, usage: 0 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, ENDPOINT_CONTENTS, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { urls: [req.url], text: true },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<ExaContentsResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('exa contents body is not JSON') };

    const first = parsed.results?.[0];
    if (first === undefined || typeof first.text !== 'string') {
      return {
        ok: false,
        classification: { kind: 'our_problem', evidence: 'exa contents returned no text' },
      };
    }

    return {
      ok: true,
      data: {
        url: first.url ?? req.url,
        ...(first.title === undefined ? {} : { title: first.title }),
        content: first.text,
      },
      usage: 0,
    };
  },
};
