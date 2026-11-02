import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const ENDPOINT_SEARCH = 'https://api.tavily.com/search';
const ENDPOINT_EXTRACT = 'https://api.tavily.com/extract';
const CREDENTIAL = 'TAVILY_API_KEY';
/**
 * The request shape is **hardcoded** by the adapter and not exposed to configuration.
 * `account` only participates in local preset derivation: it does not enter the request body and
 * does not change request parameters.
 */
const SEARCH_DEPTH = 'basic';
/** Credits per request at the hardcoded `basic` search_depth (`advanced` would cost 2). */
const CREDITS_PER_SEARCH = 1;
/** Extract is conservatively counted as 1 credit/call (officially 1 credit per 5 successful URLs). */
const CREDITS_PER_EXTRACT = 1;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    // Missing credentials should not reach here — the routing layer already excludes on bit 2. Defensive anyway, so `undefined` is never interpolated into the request headers.
    if (key === null)
        throw new Error('TAVILY_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const tavilyAdapter = {
    id: 'tavily',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'tavily',
        requiresCredentials: true,
        // Canonical credential name. Exactly this name must be written in the config — the adapter reads by fixed name and accepts no aliases.
        credentialNames: [CREDENTIAL],
        // The request shape is hardcoded, so there are no account tier options.
        accountOptions: {},
    },
    errorHints: {
    // 429 is ambiguous: over-limit and exhausted monthly quota both return it, so the response body
    // distinguishes them.
    },
    init(account) {
        return {
            version: 1,
            canCharge: false,
            // Official: 1,000 credits/month, reset monthly
            quotaPeriod: 'month',
            dayLimit: null,
            monthLimit: 1_000,
            unit: 'credits',
            resetTimezone: 'UTC',
        };
    },
    usageOf(capability) {
        return capability === 'search' ? CREDITS_PER_SEARCH : CREDITS_PER_EXTRACT;
    },
    async search(ctx, req) {
        const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                search_depth: SEARCH_DEPTH,
                ...(req.maxResults === undefined ? {} : { max_results: req.maxResults }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('tavily search body is not JSON') };
        const hits = (parsed.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? r.url ?? '',
            url: r.url,
            ...(r.content === undefined ? {} : { snippet: r.content }),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, ENDPOINT_EXTRACT, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: { urls: [req.url] },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('tavily extract body is not JSON') };
        const first = parsed.results?.[0];
        if (first === undefined || typeof first.raw_content !== 'string') {
            // A 2xx with no body is not a transport failure but is of no value to the caller, so it is surfaced as our problem (no flag set).
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `tavily extract returned no content (failed_results=${parsed.failed_results?.length ?? 0})`,
                },
            };
        }
        return {
            ok: true,
            data: {
                url: first.url ?? req.url,
                ...(first.title === undefined ? {} : { title: first.title }),
                content: first.raw_content,
            },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map