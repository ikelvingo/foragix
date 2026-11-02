/**
 * You.com adapter (ydc-index.io v1).
 *
 * Facts below were verified 2026-11-02 against you.com's official docs — the current
 * documented REST surface, replacing the 2026-10-28 assessment whose free path rested on
 * MCP only (documents/providers/you.md).
 *
 *  - Endpoints: `POST /v1/search` and `POST /v1/contents` on `https://ydc-index.io`,
 *    auth `X-API-Key: $YDC_API_KEY`. Only POST is used; the GET form is maintenance-mode.
 *  - Search body: `{query, count}` (count = `maxResults`, clamped 1–100); the `extraction`
 *    add-on is NOT sent — in-page highlights/full-page belong to fetch and would bill extra
 *    ($1/1k live-crawled pages).
 *  - Search response: `results.web[]` with `title`/`url`/`description`/`snippets[]`.
 *  - Fetch body: `{urls: [url], formats: ["markdown"]}`; response is a JSON **array** with
 *    items `{url, title, markdown?, html?}`.
 *  - Billing: pay-as-you-go credits (search $5/1k calls, contents $1/1k pages), no
 *    day/month reset — so the adapter declares `quotaPeriod 'none'`; a 402-exhaustion bit
 *    clears only through an external event (credit top-up). `canCharge` is true: the paid
 *    gate applies by default.
 *  - A 429 whose body carries `spend_cap_exceeded` is a per-key spending cap that retrying
 *    cannot clear — it is classified as a durable quota state (period unknown), NOT a
 *    short-window cooldown, so the engine stops hammering a capped key
 *    (documents/providers/you.md → Errors; verified 2026-11-02).
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'YDC_API_KEY';
const BASE_URL = 'https://ydc-index.io';
const MAX_COUNT = 100;

interface YouSearchWebItem {
  title?: string;
  url?: string;
  description?: string;
  snippets?: string[];
}

interface YouSearchResponse {
  results?: { web?: YouSearchWebItem[] };
}

interface YouContentItem {
  url?: string;
  title?: string;
  html?: string | null;
  markdown?: string | null;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('YDC_API_KEY is missing; the routing layer should have excluded this provider');
  return { 'x-api-key': key };
}

export const youAdapter: ProviderAdapter = {
  id: 'you',
  capabilities: ['search', 'fetch'],

  schema: {
    id: 'you',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  // The 403 scope/wrong-host bodies are covered by the default "our problem" rule.
  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      // Consumption of the prepaid credit balance ($100 sign-up credits, then PAYG only when
      // topped up): no cash-flow event until a 402 answers as quota exhaustion.
      billingKind: 'included',
      // Credit-based spend: no vendor reset window to track.
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
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        query: req.query,
        ...(count === undefined ? {} : { count }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') {
      if (verdict.kind === 'rate_limited_short' && result.data.body.includes('spend_cap_exceeded')) {
        // Verified: a per-key spending cap is not lifted by waiting — treat as durable quota.
        return {
          ok: false,
          classification: {
            kind: 'quota',
            period: null,
            evidence: 'you.com 429 spend_cap_exceeded — the spending cap is not lifted by retrying',
          },
        };
      }
      return { ok: false, classification: verdict };
    }

    const parsed = parseJson<YouSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('you search body is not JSON') };

    const hits: SearchHit[] = (parsed.results?.web ?? [])
      .filter((r): r is YouSearchWebItem => typeof r?.url === 'string')
      .map((r) => {
        const snippet =
          typeof r.description === 'string' && r.description !== ''
            ? r.description
            : Array.isArray(r.snippets) && r.snippets.length > 0
              ? r.snippets[0]
              : undefined;
        return {
          title: r.title ?? '',
          url: r.url as string,
          ...(snippet === undefined ? {} : { snippet }),
        };
      });

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/contents`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { urls: [req.url], formats: ['markdown'] },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') {
      if (verdict.kind === 'rate_limited_short' && result.data.body.includes('spend_cap_exceeded')) {
        return {
          ok: false,
          classification: {
            kind: 'quota',
            period: null,
            evidence: 'you.com 429 spend_cap_exceeded — the spending cap is not lifted by retrying',
          },
        };
      }
      return { ok: false, classification: verdict };
    }

    const parsed = parseJson<YouContentItem[]>(result.data.body);
    if (parsed === null || !Array.isArray(parsed)) {
      return { ok: false, classification: classifyParseFailure('you contents body is not a JSON array') };
    }

    const item = parsed.find((entry) => typeof entry?.markdown === 'string' || typeof entry?.html === 'string');
    if (item === undefined) {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `you contents returned ${parsed.length} item(s) with no markdown/html content`,
        },
      };
    }

    const content = typeof item.markdown === 'string' && item.markdown !== '' ? item.markdown : (item.html as string);
    return {
      ok: true,
      data: {
        url: req.url,
        ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
        content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
