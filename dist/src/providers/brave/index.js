import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'BRAVE_API_KEY';
const ENDPOINT_SEARCH = 'https://api.search.brave.com/res/v1/web/search';
const MAX_COUNT = 20;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('BRAVE_API_KEY is missing; the routing layer should have excluded this provider');
    return { 'x-subscription-token': key };
}
/** The monthly window is the second CSV value of `X-RateLimit-Remaining`; null when absent. */
function monthlyRemaining(headers) {
    const raw = headers?.['x-ratelimit-remaining'];
    if (raw === undefined)
        return null;
    const values = raw
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isInteger(value));
    return values.length > 0 ? values[values.length - 1] : null;
}
export const braveAdapter = {
    id: 'brave',
    capabilities: ['search'],
    schema: {
        id: 'brave',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        // 本地预算：免费额度建立在绑卡上，超出即真实扣卡——这是全名册唯一有此结构的供应商
        localCap: true,
        accountOptions: {
            capped_free: {
                type: 'boolean',
                default: true,
                description: 'Limit brave to its counted monthly free allowance; false removes the local brake',
            },
        },
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'month',
            dayLimit: null,
            // ≈ the $5 monthly credits at the Search rate; the vendor grants credits, not a request count.
            monthLimit: 1_000,
            unit: 'requests',
            // The monthly reset calendar boundary is not documented; UTC is the explicit approximation.
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
        const url = new URL(ENDPOINT_SEARCH);
        url.searchParams.set('q', req.query);
        if (count !== undefined)
            url.searchParams.set('count', String(count));
        const result = await request(ctx.fetchImpl, url.toString(), {
            method: 'GET',
            headers: authHeaders(ctx),
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind === 'rate_limited_short') {
            // Verified header semantics: the monthly CSV value reaching 0 means the monthly window is
            // exhausted — a persistent quota bit, not a once-per-second cooldown.
            if (monthlyRemaining(result.data.headers) === 0) {
                return {
                    ok: false,
                    classification: {
                        kind: 'quota',
                        period: 'month',
                        evidence: 'brave rate-limit header shows the monthly window at 0 remaining',
                    },
                };
            }
            return { ok: false, classification: verdict };
        }
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('brave search body is not JSON') };
        const hits = (parsed.web?.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            ...(typeof r.description === 'string' ? { snippet: r.description } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
};
//# sourceMappingURL=index.js.map