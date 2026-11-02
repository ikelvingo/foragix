import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'ANYSEARCH_API_KEY';
const BASE_URL = 'https://api.anysearch.com';
const MAX_RESULTS = 10;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('ANYSEARCH_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const anysearchAdapter = {
    id: 'anysearch',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'anysearch',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'day',
            dayLimit: 1_000,
            monthLimit: null,
            unit: 'calls',
            // The reset clock/timezone is undocumented; UTC is the explicit approximation.
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const max_results = req.maxResults === undefined ? undefined : Math.min(MAX_RESULTS, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                ...(max_results === undefined ? {} : { max_results }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('anysearch search body is not JSON') };
        if (parsed.code !== undefined && parsed.code !== 0) {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `anysearch envelope code=${parsed.code} on a 2xx response`,
                },
            };
        }
        const hits = (parsed.data?.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            ...(typeof r.snippet === 'string' && r.snippet !== '' ? { snippet: r.snippet } : typeof r.content === 'string' ? { snippet: r.content } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/extract`, {
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
            return { ok: false, classification: classifyParseFailure('anysearch extract body is not JSON') };
        if (parsed.code !== undefined && parsed.code !== 0) {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `anysearch envelope code=${parsed.code} on a 2xx response`,
                },
            };
        }
        if (typeof parsed.data?.content !== 'string') {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: 'anysearch extract returned no content field',
                },
            };
        }
        const title = typeof parsed.data.title === 'string' && parsed.data.title !== '' ? parsed.data.title : undefined;
        const url = typeof parsed.data.url === 'string' && parsed.data.url !== '' ? parsed.data.url : req.url;
        return {
            ok: true,
            data: { url, content: parsed.data.content, ...(title === undefined ? {} : { title }) },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map