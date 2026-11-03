/**
 * Zhihu content-target parsing.
 *
 * Only the documented creator-detail forms are recognised; the canonical URL (https, no query or
 * fragment) is what the official `ContentUrl` parameter expects. Everything else returns null and
 * the caller falls back to the ordinary fetch chain.
 */
const CONTENT_HOSTS = new Set(['zhihu.com', 'www.zhihu.com', 'zhuanlan.zhihu.com']);
const SUPPORTED_PATHS = [
    /^\/answer\/[0-9]+$/,
    /^\/question\/[0-9]+\/answer\/[0-9]+$/,
    /^\/p\/[0-9]+$/,
    /^\/pin\/[0-9]+$/,
    /^\/zvideo\/[0-9]+$/,
];
/** `https://<zhihu host>/<supported content path>` → canonical URL; anything else → null. */
export function parseZhihuUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:')
        return null;
    if (url.username !== '' || url.password !== '')
        return null;
    if (!CONTENT_HOSTS.has(url.hostname))
        return null;
    if (!SUPPORTED_PATHS.some((pattern) => pattern.test(url.pathname)))
        return null;
    return `${url.origin}${url.pathname}`;
}
/** True when the API's returned URL denotes the same content as the canonical target. */
export function sameZhihuContent(returned, canonical) {
    if (typeof returned !== 'string')
        return false;
    return parseZhihuUrl(returned) === canonical;
}
/** Strip tags from the creator-detail `Body` so the tool returns text, not markup. */
export function htmlToText(html) {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
//# sourceMappingURL=target.js.map