/**
 * Target parsing for source-preferred fetch.
 *
 * The official Baike APIs take a name or an id — never a page URL — so a URL is translated here and
 * the answer is only used when the returned lemma still matches it. Anything unrecognised returns
 * null and the caller falls back to the ordinary fetch chain.
 */
export interface LemmaTarget {
    readonly searchType: 'lemmaId' | 'lemmaTitle';
    readonly searchKey: string;
}
/** `https://baike.baidu.com/item/<name>[/<numeric id>]`; https only, no credentials, no lookalike host. */
export declare function parseBaikeUrl(raw: string): LemmaTarget | null;
/** The numeric id inside a lemma response's own `url`, used to prove the answer is the requested sense. */
export declare function lemmaIdFromUrl(value: unknown): string | null;
