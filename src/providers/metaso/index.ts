/**
 * Metaso (秘塔) adapter.
 *
 * Facts below were verified 2026-11-02 (live probe + metaso.cn API docs; see
 * documents/providers/metaso.md).
 *
 *  - Search-only: `POST https://metaso.cn/api/v1/search`, Bearer auth
 *    (`{q, scope: "all", count}`); response `{credits, searchParameters, webpages[]}` with
 *    `webpages[{title, link, score, snippet}]`. The `credits` field carries the account
 *    balance — it is evidence for status output, not a per-call cost signal.
 *  - Quota model: prepaid credits draw down per search (counted locally against a monthly
 *    ceiling is NOT possible without a documented call price, so limits stay null and the
 *    balance-exhaustion bit clears only through an external event).
 *  - Billing: consumption of a prepaid credit balance — `canCharge` true, the paid gate
 *    applies by default (same stance as the other credit-consumption providers).
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

const CREDENTIAL = 'METASO_API_KEY';
const ENDPOINT_SEARCH = 'https://metaso.cn/api/v1/search';
const MAX_COUNT = 50;

interface MetasoSearchResponse {
  credits?: number;
  webpages?: Array<{ title?: string; link?: string; score?: string; snippet?: string }>;
  message?: string;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('METASO_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

export const metasoAdapter: ProviderAdapter = {
  id: 'metaso',
  capabilities: ['search'],

  schema: {
    id: 'metaso',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {},
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      // Prepaid credits with no documented per-call price or reset window: exhaustion is
      // durable until an external event (top-up), same stance as the minimax plan pool.
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'credits',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: {
        q: req.query,
        scope: 'all',
        ...(count === undefined ? {} : { count }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<MetasoSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('metaso search body is not JSON') };

    // Some metaso error responses still arrive with 2xx + message semantics; redact and refuse.
    if (typeof parsed.message === 'string' && parsed.message !== '' && !Array.isArray(parsed.webpages)) {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `metaso envelope message: ${redact(parsed.message, 80)}`,
        },
      };
    }

    const hits: SearchHit[] = (parsed.webpages ?? [])
      .filter((r): r is { title?: string; link?: string; snippet?: string } => typeof r?.link === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.link as string,
        ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
