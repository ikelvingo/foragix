import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
export const BAIDU_CREDENTIAL = 'BAIDU_API_KEY';
const HOST_APPBUILDER = 'https://appbuilder.baidu.com';
const HOST_QIANFAN = 'https://qianfan.baidubce.com';
function authHeaders(ctx) {
    const key = ctx.credentials.get(BAIDU_CREDENTIAL);
    if (key === null)
        throw new Error('BAIDU_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
/** Unwraps the `{code, message, result}` envelope; code "0" (string or number) means success. */
function unwrap(parsed, label) {
    if (parsed === null)
        return { ok: false, classification: classifyParseFailure(`${label} body is not JSON`) };
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
async function get(ctx, url, label) {
    const result = await request(ctx.fetchImpl, url.toString(), { method: 'GET', headers: authHeaders(ctx) });
    if (!result.ok)
        return result;
    const verdict = interpret(result.data, undefined, ctx.now());
    if (verdict.kind !== 'success')
        return { ok: false, classification: verdict };
    return unwrap(parseJson(result.data.body), label);
}
/** Same-title senses. The documented response shape is inconsistent across examples, so the payload is returned as-is. */
export function listByTitle(ctx, title, topK) {
    const url = new URL(`${HOST_APPBUILDER}/v2/baike/lemma/get_list_by_title`);
    url.searchParams.set('lemma_title', title);
    if (topK !== undefined)
        url.searchParams.set('top_k', String(Math.min(100, Math.max(1, topK))));
    return get(ctx, url, 'baidu baike list');
}
/** One sense's structured content (summary/abstract/relations/…); the official abstract is bounded, not full text. */
export function getContent(ctx, searchType, searchKey) {
    const url = new URL(`${HOST_APPBUILDER}/v2/baike/lemma/get_content`);
    url.searchParams.set('search_type', searchType);
    url.searchParams.set('search_key', searchKey);
    return get(ctx, url, 'baidu baike content');
}
/** 秒懂百科 video metadata for a lemma. */
export function searchVideo(ctx, searchType, searchKey, options = {}) {
    const url = new URL(`${HOST_QIANFAN}/v2/baike/second_know/search_video`);
    url.searchParams.set('search_type', searchType);
    url.searchParams.set('search_key', searchKey);
    if (options.limit !== undefined)
        url.searchParams.set('limit', String(Math.max(1, options.limit)));
    if (options.type !== undefined)
        url.searchParams.set('type', String(options.type));
    if (options.platform !== undefined)
        url.searchParams.set('platform', options.platform);
    return get(ctx, url, 'baidu baike video');
}
//# sourceMappingURL=encyclopedia.js.map