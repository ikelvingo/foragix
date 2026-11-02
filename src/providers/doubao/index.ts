/**
 * Doubao (火山引擎 search-infinity) adapter — the standalone REST channel behind
 * `open.feedcoopapi.com/search_api/*`, verified against the vendor console entry and the
 * first-party reference client (documents/providers/doubao.md; live-reviewed 2026-11-02).
 * The 2026-10-28 "not implementable" verdict is withdrawn: the REST surface exists.
 *
 *  - Two variants, same key and one shared quota pool:
 *      * `global` — `/search_api/global_search`, body `{query, doc_count}`; the server
 *        currently answers 10 docs fixed, so `maxResults` is applied client-side.
 *      * `custom` — `/search_api/web_search`, body `{Query, SearchType: "web", Count}`
 *        (Count really applies; richer Content).
 *  - Response envelope: `{ResponseMetadata: {Error?}, Result: {Documents?|WebResults?}}`;
 *    global items carry Title/Url/HostInfo/DocumentInfo{PublishTime, ContentTokenCount}/
 *    Snippet[{Type: text|image}]; custom items carry Title/Url/SiteName/PublishTime/Content.
 *  - Quota: 500 free searches/month shared by both variants; beyond it pay-per-call
 *    post-paid billing — `canCharge` true (paid gate applies by default), day/month reset
 *    monthly.
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

const CREDENTIAL = 'DOUBAO_SEARCH_API_KEY';
const BASE_URL = 'https://open.feedcoopapi.com/search_api';

interface DoubaoDoc {
  Title?: string;
  Url?: string;
  Snippet?: Array<{ Type?: string; Text?: string; Image?: { ImageUrl?: string } }>;
}

interface DoubaoGlobalResponse {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: { Documents?: DoubaoDoc[] };
}

interface DoubaoWebResult {
  Title?: string;
  Url?: string;
  SiteName?: string;
  PublishTime?: string;
  Content?: string;
  Summary?: string;
  Snippet?: string;
}

interface DoubaoCustomResponse {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: { WebResults?: DoubaoWebResult[] };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('DOUBAO_SEARCH_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

/** Maps one envelope error to a classification; error text is provider-controlled. */
function envelopeError(
  err: { Code?: string; Message?: string } | undefined,
): AdapterOutcome<SearchHit[]> {
  return {
    ok: false,
    classification: {
      kind: 'our_problem',
      evidence: `doubao envelope error ${err?.Code ?? 'unknown'} (${redact(err?.Message ?? 'no message', 80)})`,
    },
  };
}

export const doubaoAdapter: ProviderAdapter = {
  id: 'doubao',
  capabilities: ['search'],

  schema: {
    id: 'doubao',
    requiresCredentials: true,
    credentialNames: [CREDENTIAL],
    accountOptions: {
      version: {
        type: 'string',
        allowedValues: ['global', 'custom'],
        default: 'global',
        description: 'global = token-counted long-index variant; custom = richer-content variant (Count applies)',
      },
    },
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      quotaPeriod: 'month',
      dayLimit: null,
      monthLimit: 500,
      unit: 'searches',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const version = ctx.config.account['version'] === 'custom' ? 'custom' : 'global';
    const count = req.maxResults === undefined ? undefined : Math.min(50, Math.max(1, req.maxResults));

    const endpoint = version === 'custom' ? `${BASE_URL}/web_search` : `${BASE_URL}/global_search`;
    const body =
      version === 'custom'
        ? {
            Query: req.query,
            SearchType: 'web',
            ...(count === undefined ? {} : { Count: count }),
          }
        : {
            query: req.query,
            ...(count === undefined ? {} : { doc_count: count }),
          };

    const result = await request(ctx.fetchImpl, endpoint, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: body,
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    if (version === 'custom') {
      const parsed = parseJson<DoubaoCustomResponse>(result.data.body);
      if (parsed === null) return { ok: false, classification: classifyParseFailure('doubao search body is not JSON') };
      const err = parsed.ResponseMetadata?.Error;
      if (err !== undefined) return envelopeError(err);

      const webResults = parsed.Result?.WebResults ?? [];
      const hits: SearchHit[] = webResults
        .filter((r): r is DoubaoWebResult & { Url: string } => typeof r?.Url === 'string')
        .map((r) => ({
          title: r.Title ?? '',
          url: r.Url,
          ...(typeof r.Content === 'string' && r.Content !== ''
            ? { snippet: r.Content }
            : typeof r.Summary === 'string' && r.Summary !== ''
              ? { snippet: r.Summary }
              : typeof r.PublishTime === 'string'
                ? { snippet: r.PublishTime }
                : {}),
        }));
      return { ok: true, data: hits.slice(0, count ?? hits.length), usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    }

    const parsed = parseJson<DoubaoGlobalResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('doubao search body is not JSON') };
    const err = parsed.ResponseMetadata?.Error;
    if (err !== undefined) return envelopeError(err);

    const docs = parsed.Result?.Documents ?? [];
    const hits: SearchHit[] = docs
      .filter((d): d is DoubaoDoc & { Url: string } => typeof d?.Url === 'string')
      .map((d) => ({
        title: d.Title ?? '',
        url: d.Url,
        ...(Array.isArray(d.Snippet) ? { snippet: d.Snippet.filter((s) => s.Type === 'text' && typeof s.Text === 'string').map((s) => s.Text as string).join(' ') } : {}),
      }));
    return { ok: true, data: hits.slice(0, count ?? hits.length), usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
