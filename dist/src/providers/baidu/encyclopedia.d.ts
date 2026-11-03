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
export declare const BAIDU_CREDENTIAL = "BAIDU_API_KEY";
export type LemmaSearchType = 'lemmaTitle' | 'lemmaId';
export interface BaiduEnvelope<T> {
    request_id?: string;
    code?: string | number;
    message?: string;
    result?: T;
}
/** Same-title senses. The documented response shape is inconsistent across examples, so the payload is returned as-is. */
export declare function listByTitle(ctx: AdapterContext, title: string, topK?: number): Promise<AdapterOutcome<unknown>>;
/** One sense's structured content (summary/abstract/relations/…); the official abstract is bounded, not full text. */
export declare function getContent(ctx: AdapterContext, searchType: LemmaSearchType, searchKey: string): Promise<AdapterOutcome<unknown>>;
/** 秒懂百科 video metadata for a lemma. */
export declare function searchVideo(ctx: AdapterContext, searchType: LemmaSearchType, searchKey: string, options?: {
    limit?: number;
    type?: 0 | 1;
    platform?: string;
}): Promise<AdapterOutcome<unknown>>;
