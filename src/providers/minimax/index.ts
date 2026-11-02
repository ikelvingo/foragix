/**
 * MiniMax adapter (Token/M-Plan web search).
 *
 * Facts below were verified 2026-11-02 against the first-party mmx-cli SDK sources in the local
 * install and the official M-Plan docs; the official REST reference page for the endpoint is
 * currently 404, which is an accepted, documented gap (see documents/providers/minimax.md).
 *
 *  - Search-only: MiniMax publishes no standalone fetch/web-reader REST endpoint.
 *  - Request: `POST ${base}/v1/coding_plan/search`, body `{"q": "<query>"}`; the endpoint returns
 *    at most 10 results and does not support pagination, so `maxResults` cannot be honored.
 *  - Success response: `{"organic": [{title, link, snippet, date}]}`.
 *  - HTTP-200 envelope errors: `base_resp.status_code`; `1028`/`1030` are verified quota codes;
 *    `1002`/`1039`/`1026`/`1027` are moderation/withholding codes; `2061` model not on plan.
 *  - Quota model: dual 5-hour rolling window + 7-day weekly window, probed via
 *    `GET /v1/token_plan/remains`. The engine's bitmask cannot represent those windows, and
 *    approximating a 5-hour window as a day or a rate-limit cooldown was explicitly rejected.
 *    So this adapter declares `quotaPeriod 'none'`: an exhaustion bit is durable and clears
 *    only through an external event — config reload, credential change, or manual intervention.
 *  - Consumption draws down a pre-purchased plan subscription, so `canCharge` is true and the
 *    paid gate applies (default off) until the user accepts plan usage.
 */
import type { AdapterContext, AdapterOutcome, ProviderAdapter, ProviderInit, SearchHit } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';

const CREDENTIAL = 'MINIMAX_API_KEY';
const DEFAULT_BASE_URL = 'https://api.minimax.io';

interface MinimaxSearchResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Moderation / plan-scope envelope codes that are not quota: no flags, surfaced prominently. */
const OUR_PROBLEM_CODES = new Set([1002, 1039, 1026, 1027, 2061]);

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(CREDENTIAL);
  if (key === null) throw new Error('MINIMAX_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

function baseUrl(ctx: AdapterContext): string {
  const raw = ctx.config.account['base_url'];
  if (typeof raw === 'string' && raw !== '') {
    return raw.replace(/\/+$/, '');
  }
  return DEFAULT_BASE_URL;
}

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  capabilities: ['search'],

  schema: {
    id: 'minimax',
    requiresCredentials: true,
    // Consumption depends on an account-side subscription/prepaid setup the skill cannot
    // verify (minimax plan key, zhipu resource pack, deepseek per-call billing). Fresh
    // installs must not call it until the owner enables it in the config.
    defaultEnabled: false,
    credentialNames: [CREDENTIAL],
    accountOptions: {
      base_url: {
        type: 'string',
        default: DEFAULT_BASE_URL,
        description: 'MiniMax REST host; cn-region accounts may use https://api.minimax.cn',
      },
    },
  },

  errorHints: {
    // Verified quota codes extracted from `base_resp.status_code` on an HTTP-200 envelope.
    quotaErrorCodes: ['1028', '1030'],
  },

  init(_account): ProviderInit {
    return {
      version: 1,
      canCharge: true,
      // Dual 5h+7d windows are not representable; exhaustion is durable until an external event.
      quotaPeriod: 'none',
      dayLimit: null,
      monthLimit: null,
      unit: 'plan-requests',
      resetTimezone: 'UTC',
    };
  },

  usageOf(): number {
    return 1;
  },

  /**
   * Lane A: after a quota refusal the engine may probe this read endpoint once per window.
   * Returns the vendor-declared boundary (`general` row's `end_time`) when that value lies in
   * the future; anything unusable degrades to null (QUOTA_UNKNOWN instead of a guess).
   */
  async probeReset(ctx: AdapterContext): Promise<number | null> {
    const result = await request(ctx.fetchImpl, `${baseUrl(ctx)}/v1/token_plan/remains`, {
      method: 'GET',
      headers: authHeaders(ctx),
    });
    if (!result.ok) return null;
    const parsed = parseJson<{ model_remains?: Array<{ model_name?: string; end_time?: number }> }>(result.data.body);
    if (parsed === null) return null;
    const general = (parsed.model_remains ?? []).find((r) => r?.model_name === 'general');
    const endTime = typeof general?.end_time === 'number' ? general.end_time : Number(general?.end_time);
    if (!Number.isFinite(endTime) || endTime <= ctx.now()) return null;
    return endTime;
  },

  async search(ctx, req): Promise<AdapterOutcome<SearchHit[]>> {
    const result = await request(ctx.fetchImpl, `${baseUrl(ctx)}/v1/coding_plan/search`, {
      method: 'POST',
      headers: authHeaders(ctx),
      json: { q: req.query },
    });
    if (!result.ok) return result;

    const verdict = interpret(result.data, this.errorHints, ctx.now());
    if (verdict.kind !== 'success') return { ok: false, classification: verdict };

    const parsed = parseJson<MinimaxSearchResponse>(result.data.body);
    if (parsed === null) return { ok: false, classification: classifyParseFailure('minimax search body is not JSON') };

    // A 200 envelope can still carry an error. Verified quota codes are handled by the hints;
    // other known non-quota codes (and unknown codes) are "our problem": no flags set, next
    // provider takes over, and the reason is surfaced prominently.
    const code = parsed.base_resp?.status_code;
    if (typeof code === 'number' && code !== 0) {
      if (OUR_PROBLEM_CODES.has(code) || !Number.isInteger(code)) {
        return {
          ok: false,
          classification: {
            kind: 'our_problem',
            evidence: `minimax envelope status_code=${code} (${parsed.base_resp?.status_msg ?? 'no message'})`,
          },
        };
      }
      return {
        ok: false,
        classification: {
          kind: 'our_problem',
          evidence: `minimax envelope status_code=${code}; not a verified quota or moderation code`,
        },
      };
    }

    const hits: SearchHit[] = (parsed.organic ?? [])
      .filter((r): r is { title?: string; link?: string; snippet?: string; date?: string } => typeof r?.link === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.link as string,
        ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
      }));

    return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
  },
};
