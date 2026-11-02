/**
 * SearXNG adapter (self-hosted instance).
 *
 * Facts below were verified 2026-11-02 against docs.searxng.org and a live probe of the
 * configured instance (documents/providers/searxng.md).
 *
 *  - No credential system: instance-side access control only, so the adapter requires no
 *    keys. The instance base URL is a config `account` option, defaulting to the owner's
 *    deployment `https://search.ikelvin.space:8443` (per the owner's instruction).
 *  - Search: `GET {base}/search?q=<query>&format=json`. The JSON format must be enabled
 *    instance-side (`search.formats`); a 403 then means "format disabled", not auth.
 *  - Success response: `results[]` with `url`/`title`/`content`; `unresponsive_engines[]`
 *    is the health signal — upstream CAPTCHA/denials produce 200 with degraded results.
 *  - A forged client IP (`X-Forwarded-For`) must NOT be sent: it breaks the limiter.
 *  - Self-hosted: no billing, no platform quota — `canCharge` false and no countable
 *    limits; upstream-engine pressure degrades results rather than failing HTTP-level.
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const DEFAULT_BASE_URL = 'https://search.ikelvin.space:8443';

interface SearxngSearchResponse {
  results?: Array<{ url?: string; title?: string; content?: string }>;
  unresponsive_engines?: Array<unknown>;
}

function baseUrl(ctx: AdapterContext): string {
  const raw = ctx.config.account['base_url'];
  if (typeof raw === 'string' && raw !== '') return raw.replace(/\/+$/, '');
  return DEFAULT_BASE_URL;
}

export const searxngAdapter: ProviderAdapter = {
  id: 'searxng',
  capabilities: ['search'],

  schema: {
    id: 'searxng',
    credentialNames: [],
    accountOptions: {
      base_url: {
        type: 'string',
        default: DEFAULT_BASE_URL,
        description: 'The self-hosted SearXNG instance base URL',
      },
    },
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: false,
      // No platform quota exists; upstream-engine pressure is not a locally countable quota.
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
    const url = new URL(`${baseUrl(ctx)}/search`);
    url.searchParams.set('q', req.query);
    url.searchParams.set('format', 'json');

    // Deliberately plain headers: the limiter derives the client IP from its own socket,
    // and forged X-Forwarded-For values make bot detection misbehave.
    const result = await request(ctx.fetchImpl, url.toString(), { method: 'GET' });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<SearxngSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('searxng search body is not JSON') };

    const hits: SearchHit[] = (parsed.results ?? [])
      .filter((r): r is { url?: string; title?: string; content?: string } => typeof r?.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        ...(typeof r.content === 'string' ? { snippet: r.content } : {}),
      }));

    // Health signal per the admin docs: 200 with zero results while every engine refused
    // the instance is upstream degradation, not a legitimately empty match.
    if (hits.length === 0 && (parsed.unresponsive_engines ?? []).length > 0) {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `searxng returned no results with ${parsed.unresponsive_engines?.length} unresponsive engine(s)`,
        },
      };
    }

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
