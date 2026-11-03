/**
 * Baidu Qianfan Baike (百科) client.
 *
 * Contract verified 2026-11-04 against the three official pages:
 *  - list:   GET https://appbuilder.baidu.com/v2/baike/lemma/get_list_by_title
 *  - content GET https://appbuilder.baidu.com/v2/baike/lemma/get_content
 *  - video:  GET https://qianfan.baidubce.com/v2/baike/second_know/search_video
 *
 * All three use `Authorization: Bearer <API key>`, take their target by name or id (never a page
 * URL), and answer `{request_id, code, message, result}` where code is the **string** "0" on
 * success. The exact per-field payload is preserved verbatim: this client is a transport, not a
 * schema.
 */
import type { AdapterContext, AdapterOutcome } from '../types.js';
import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';

export const BAIDU_CREDENTIAL = 'BAIDU_API_KEY';

const HOST_APPBUILDER = 'https://appbuilder.baidu.com';
const HOST_QIANFAN = 'https://qianfan.baidubce.com';

export type LemmaSearchType = 'lemmaTitle' | 'lemmaId';

export interface BaiduEnvelope<T> {
  request_id?: string;
  code?: string | number;
  message?: string;
  result?: T;
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.get(BAIDU_CREDENTIAL);
  if (key === null) throw new Error('BAIDU_API_KEY is missing; the routing layer should have excluded this provider');
  return { authorization: `Bearer ${key}` };
}

/** Unwraps the `{code, message, result}` envelope; code "0" (string or number) means success. */
function unwrap<T>(parsed: BaiduEnvelope<T> | null, label: string): AdapterOutcome<T> {
  if (parsed === null) return { ok: false, classification: classifyParseFailure(`${label} body is not JSON`) };
  if (parsed.code !== undefined && String(parsed.code) !== '0') {
    return {
      ok: false,
      classification: {
        kind: 'our_problem',
        evidence: `${label} envelope code=${String(parsed.code)} (${redact(parsed.message ?? 'no message', 80)})`,
      },
    };
  }
  if (parsed.result === undefined) {
    return { ok: false, classification: classifyParseFailure(`${label} envelope has no result`) };
  }
  return { ok: true, data: parsed.result, usage: 1 };
}

async function get<T>(ctx: AdapterContext, url: URL, label: string): Promise<AdapterOutcome<T>> {
  const result = await request(ctx.fetchImpl, url.toString(), { method: 'GET', headers: authHeaders(ctx) });
  if (!result.ok) return result;
  const verdict = interpret(result.data, undefined, ctx.now());
  if (verdict.kind !== 'success') return { ok: false, classification: verdict };
  return unwrap(parseJson<BaiduEnvelope<T>>(result.data.body), label);
}

/** Same-title senses. The documented response shape is inconsistent across examples, so the payload is returned as-is. */
export function listByTitle(
  ctx: AdapterContext,
  title: string,
  topK?: number,
): Promise<AdapterOutcome<unknown>> {
  const url = new URL(`${HOST_APPBUILDER}/v2/baike/lemma/get_list_by_title`);
  url.searchParams.set('lemma_title', title);
  if (topK !== undefined) url.searchParams.set('top_k', String(Math.min(100, Math.max(1, topK))));
  return get<unknown>(ctx, url, 'baidu baike list');
}

/** One sense's structured content (summary/abstract/relations/…); the official abstract is bounded, not full text. */
export function getContent(
  ctx: AdapterContext,
  searchType: LemmaSearchType,
  searchKey: string,
): Promise<AdapterOutcome<unknown>> {
  const url = new URL(`${HOST_APPBUILDER}/v2/baike/lemma/get_content`);
  url.searchParams.set('search_type', searchType);
  url.searchParams.set('search_key', searchKey);
  return get<unknown>(ctx, url, 'baidu baike content');
}

/** 秒懂百科 video metadata for a lemma. */
export function searchVideo(
  ctx: AdapterContext,
  searchType: LemmaSearchType,
  searchKey: string,
  options: { limit?: number; type?: 0 | 1; platform?: string } = {},
): Promise<AdapterOutcome<unknown>> {
  const url = new URL(`${HOST_QIANFAN}/v2/baike/second_know/search_video`);
  url.searchParams.set('search_type', searchType);
  url.searchParams.set('search_key', searchKey);
  if (options.limit !== undefined) url.searchParams.set('limit', String(Math.max(1, options.limit)));
  if (options.type !== undefined) url.searchParams.set('type', String(options.type));
  if (options.platform !== undefined) url.searchParams.set('platform', options.platform);
  return get<unknown>(ctx, url, 'baidu baike video');
}
