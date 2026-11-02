import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
const CREDENTIAL = 'LINKUP_API_KEY';
const BASE_URL = 'https://api.linkup.so';
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('LINKUP_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const linkupAdapter = {
    id: 'linkup',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'linkup',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'none',
            dayLimit: null,
            monthLimit: null,
            unit: 'requests',
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                q: req.query,
                depth: 'standard',
                outputType: 'searchResults',
                includeImages: false,
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('linkup search body is not JSON') };
        const hits = (parsed.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.name ?? r.title ?? '',
            url: r.url,
            ...(typeof r.content === 'string' && r.content !== '' ? { snippet: r.content } : typeof r.text === 'string' ? { snippet: r.text } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/fetch`, {
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
            return { ok: false, classification: classifyParseFailure('linkup fetch body is not JSON') };
        const content = typeof parsed.content === 'string' ? parsed.content : typeof parsed.text === 'string' ? parsed.text : undefined;
        if (content === undefined || content === '') {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: 'linkup fetch returned no content in a 2xx response',
                },
            };
        }
        return {
            ok: true,
            data: {
                url: req.url,
                ...(typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {}),
                content,
            },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map