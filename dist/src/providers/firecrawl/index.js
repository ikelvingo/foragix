import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'FIRECRAWL_API_KEY';
const BASE_URL = 'https://api.firecrawl.dev';
const MAX_LIMIT = 100;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('FIRECRAWL_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const firecrawlAdapter = {
    id: 'firecrawl',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'firecrawl',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'month',
            dayLimit: null,
            monthLimit: 1_000,
            unit: 'credits',
            resetTimezone: 'UTC',
        };
    },
    /** Search is billed per 10-result block (2 credits); scrape 1 credit per page. */
    usageOf(capability) {
        return capability === 'search' ? 2 : 1;
    },
    async search(ctx, req) {
        const limit = req.maxResults === undefined ? undefined : Math.min(MAX_LIMIT, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v2/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                ...(limit === undefined ? {} : { limit }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('firecrawl search body is not JSON') };
        const hits = (parsed.data?.web ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            ...(typeof r.description === 'string' ? { snippet: r.description } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 2 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v2/scrape`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: { url: req.url },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('firecrawl scrape body is not JSON') };
        const data = parsed.data ?? {};
        // Content preference per the documented format priority; all three fields are optional.
        const content = typeof data.markdown === 'string' ? data.markdown : typeof data.html === 'string' ? data.html : typeof data.rawHtml === 'string' ? data.rawHtml : undefined;
        if (content === undefined || content === '') {
            // 404-class responses (no usable content) arrive as HTTP 404 and are classified by the
            // verified status catalog; a 2xx without content is of no value to the caller.
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: 'firecrawl scrape returned no content in a 2xx response',
                },
            };
        }
        const title = typeof data.metadata?.title === 'string' ? data.metadata.title : typeof data.title === 'string' ? data.title : undefined;
        const url = typeof data.metadata?.sourceURL === 'string' && data.metadata.sourceURL !== '' ? data.metadata.sourceURL : req.url;
        return {
            ok: true,
            data: { url, content, ...(title === undefined ? {} : { title }) },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map