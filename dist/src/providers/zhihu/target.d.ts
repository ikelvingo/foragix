/** `https://<zhihu host>/<supported content path>` → canonical URL; anything else → null. */
export declare function parseZhihuUrl(raw: string): string | null;
/** True when the API's returned URL denotes the same content as the canonical target. */
export declare function sameZhihuContent(returned: unknown, canonical: string): boolean;
/** Strip tags from the creator-detail `Body` so the tool returns text, not markup. */
export declare function htmlToText(html: string): string;
