/**
 * Zhipu BigModel web search adapter.
 *
 * Facts below were verified 2026-11-02 against docs.bigmodel.cn; the standalone REST tool
 * exists and is pay-as-you-go — the dual 5-hour/weekly Coding-Plan windows apply to the
 * plan's MCP surfaces only, not to this REST endpoint (documents/providers/zhipu.md).
 *
 *  - Search: `POST https://open.bigmodel.cn/api/paas/v4/web_search`, Bearer auth.
 *    Body: `{search_query, search_engine, search_intent: false, count}` — engine pinned to
 *    the base `search_std` (tier upgrades belong to account config, not per-call), query
 *    truncated to the documented 70-char maximum, count = `maxResults` clamped 1–50.
 *    Response: `search_result[]` with `title`/`content`/`link`.
 *  - Fetch: `POST /api/paas/v4/reader` with `{url}` — response `reader_result` with
 *    `content`/`description`/`title`/`url`.
 *  - Billing: pay-as-you-go points per call; no free-call window is published for REST —
 *    `canCharge` true (paid gate by default), `quotaPeriod 'none'` (concurrency-based
 *    limiting with in-band cap codes; no locally resettable period).
 *  - Verified business codes: auth failures `1000/1001/1003/1005` (→ 401 semantics),
 *    `1308` in-band quota cap carrying an in-message reset time.
 */
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'ZHIPU_API_KEY';
const MAX_COUNT = 50;
const MAX_QUERY_CHARS = 70;

interface ZhipuSearchResponse {
  search_result?: Array<{ title?: string; content?: string; link?: string }>;
}

interface ZhipuReaderResponse {
  reader_result?: { content?: string; description?: string; title?: string; url?: string };
}

function authHeaders(ctx: AdapterContext, credentialName: string): Record<string, string> {
  const key = ctx.credentials.get(credentialName);
  if (key === null) throw new Error(`${credentialName} is missing; the routing layer should have excluded this provider`);
  return { authorization: `Bearer ${key}` };
}


/**
 * Lane A in-band: the verified `1308` refusal carries the vendor's own reset time inside its
 * message ("您的限额将在 <time> 重置", Beijing time). Extracting it here means every refusal
 * records the recovery boundary with zero extra requests.
 */
function declaredResetAt(body: string | undefined): number | undefined {
  if (body === undefined) return undefined;
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(body);
  if (match === null) return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
}


function baseUrl(ctx: AdapterContext, fallback: string): string {
  const raw = ctx.config.account['base_url'];
  if (typeof raw === 'string' && raw !== '') return raw.replace(/\/+$/, '');
  return fallback;
}

export function zhipuAdapterFor(id: 'zhipu' | 'zhipu_cn', opts: { defaultBaseUrl: string; defaultEngine: 'search_std' | 'search-prime' }): ProviderAdapter {
  return zhipuAdapterForRegion(id, opts.defaultBaseUrl, opts.defaultEngine);
}

function zhipuAdapterForRegion(id: 'zhipu' | 'zhipu_cn', defaultHost: string, defaultEngine: string): ProviderAdapter {
  // Four base urls → four credential variables; z.ai keys are minted on the z.ai console and
  // are NOT interchangeable with bigmodel.cn keys (region-split review ruling).
  const credentialName = id === 'zhipu' ? 'ZAI_API_KEY' : 'ZHIPU_API_KEY';

  return {
    id,
    capabilities: ['search', 'fetch'],

    schema: {
      id,
    requiresCredentials: true,
    // Consumption depends on an account-side subscription/prepaid setup the skill cannot
    // verify (minimax plan key, zhipu resource pack, deepseek per-call billing). Fresh
    // installs must not call it until the owner enables it in the config.
    defaultEnabled: false,
    credentialNames: [credentialName],
    // Region switch: CN by default (open.bigmodel.cn carries the standalone REST tool
    // endpoint); overseas z.ai accounts override via this config field. Same body/auth/shape.
    accountOptions: {
      base_url: {
        type: 'string',
        default: defaultHost,
        description: 'Region switch; semantics identical, only the host and default engine differ',
      },
    },
  },

  errorHints: {
    // Verified: these business codes are the auth failures of this platform (HTTP 401 family).
    authErrorCodes: ['1000', '1001', '1003', '1005'],
    // Verified: an in-band quota cap (message carries the reset time) — a quota event.
    // Verified: these business codes are quota/balance semantics of this platform — the
    // in-band cap (carries a reset time) and the arrears state (1113, live-verified 2026-11-02).
    quotaErrorCodes: ['1308', '1113'],
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      // Concurrency-based limiting; the cap error carries its own in-band reset time and no
      // vendor-declared calendar period fits here.
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'calls',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
    const result = await request(ctx.fetchImpl, `${baseUrl(ctx, defaultHost)}/web_search`, {
      method: 'POST',
      headers: authHeaders(ctx, credentialName),
      json: {
        // Hardcoded request shape: base engine, no intent pre-recognition (extra latency).
        search_query: req.query.slice(0, MAX_QUERY_CHARS),
        search_engine: defaultEngine,
        search_intent: false,
        ...(count === undefined ? {} : { count }),
      },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') {
      if (verdict.kind === 'quota' && verdict.period === null) {
        const resetAt = declaredResetAt(result.data.body);
        if (resetAt !== undefined) return { ok: false, classification: { ...verdict, resetAt } };
      }
      return { ok: false, classification: verdict };
    }

    const parsed = parseJson<ZhipuSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('zhipu search body is not JSON') };

    const hits: SearchHit[] = (parsed.search_result ?? [])
      .filter((r): r is { title?: string; content?: string; link?: string } => typeof r?.link === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.link as string,
        ...(typeof r.content === 'string' ? { snippet: r.content } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },

  async fetch(ctx, req): Promise<AdapterOutcome<FetchDocument>> {
    const result = await request(ctx.fetchImpl, `${baseUrl(ctx, defaultHost)}/reader`, {
      method: 'POST',
      headers: authHeaders(ctx, credentialName),
      json: { url: req.url },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') {
      if (verdict.kind === 'quota' && verdict.period === null) {
        const resetAt = declaredResetAt(result.data.body);
        if (resetAt !== undefined) return { ok: false, classification: { ...verdict, resetAt } };
      }
      return { ok: false, classification: verdict };
    }

    const parsed = parseJson<ZhipuReaderResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('zhipu reader body is not JSON') };

    const rr = parsed.reader_result;
    const content = rr?.content;
    if (rr === undefined || typeof content !== 'string') {
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: 'zhipu reader returned no content field in a 2xx response',
        },
      };
    }

    return {
      ok: true,
      data: {
        url: typeof rr.url === 'string' && rr.url !== '' ? rr.url : req.url,
        ...(typeof rr.title === 'string' && rr.title !== '' ? { title: rr.title } : {}),
        content,
      },
      usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
    };
  },
};
};
export const zhipuAdapter = zhipuAdapterFor('zhipu', { defaultBaseUrl: 'https://api.z.ai/api/paas/v4', defaultEngine: 'search-prime' });
export const zhipuCnAdapter = zhipuAdapterFor('zhipu_cn', { defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultEngine: 'search_std' });
