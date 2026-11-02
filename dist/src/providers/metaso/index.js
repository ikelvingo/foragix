import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
const CREDENTIAL = 'METASO_API_KEY';
const ENDPOINT_SEARCH = 'https://metaso.cn/api/v1/search';
const MAX_COUNT = 50;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('METASO_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const metasoAdapter = {
    id: 'metaso',
    capabilities: ['search'],
    schema: {
        id: 'metaso',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            // Prepaid credits with no documented per-call price or reset window: exhaustion is
            // durable until an external event (top-up), same stance as the minimax plan pool.
            quotaPeriod: 'none',
            dayLimit: null,
            monthLimit: null,
            unit: 'credits',
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, ENDPOINT_SEARCH, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                q: req.query,
                scope: 'all',
                ...(count === undefined ? {} : { count }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('metaso search body is not JSON') };
        // Some metaso error responses still arrive with 2xx + message semantics; redact and refuse.
        if (typeof parsed.message === 'string' && parsed.message !== '' && !Array.isArray(parsed.webpages)) {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `metaso envelope message: ${redact(parsed.message, 80)}`,
                },
            };
        }
        const hits = (parsed.webpages ?? [])
            .filter((r) => typeof r?.link === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.link,
            ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
};
//# sourceMappingURL=index.js.map