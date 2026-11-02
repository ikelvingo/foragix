import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
const CREDENTIAL = 'TINYFISH_API_KEY';
const SEARCH_URL = 'https://api.search.tinyfish.ai';
const FETCH_URL = 'https://api.fetch.tinyfish.ai';
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('TINYFISH_API_KEY is missing; the routing layer should have excluded this provider');
    return { 'x-api-key': key };
}
export const tinyfishAdapter = {
    id: 'tinyfish',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'tinyfish',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    // Verified availability signs arrive only as HTTP 402 with a body code, so no hints are
    // needed: the status path plus the day declaration carry the semantics.
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'day',
            // Per-capability daily allowances (12k search / 1k fetch) are not representable as
            // one provider-level limit, so local counting is disabled.
            dayLimit: null,
            monthLimit: null,
            unit: 'requests+urls',
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const url = new URL(SEARCH_URL);
        url.searchParams.set('query', req.query);
        if (req.maxResults !== undefined) {
            // Deliberately ignored: no documented count/limit parameter exists.
        }
        const result = await request(ctx.fetchImpl, url.toString(), {
            method: 'GET',
            headers: authHeaders(ctx),
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('tinyfish search body is not JSON') };
        const hits = (parsed.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, FETCH_URL, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: { urls: [req.url], format: 'markdown' },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('tinyfish fetch body is not JSON') };
        const first = (parsed.results ?? []).find((r) => typeof r?.text === 'string');
        if (first === undefined) {
            const failure = parsed.errors?.[0];
            return {
                ok: false,
                classification: {
                    // `error` is provider-controlled text: it goes through the same redactor as the
                    // generic classifier before it may enter any evidence string.
                    kind: 'our_problem',
                    evidence: `tinyfish fetch reported no usable content${failure === undefined ? '' : ` (${redact(String(failure.error ?? 'unknown'), 80)})`}`,
                },
            };
        }
        return {
            ok: true,
            data: {
                url: typeof first.url === 'string' ? first.url : req.url,
                ...(typeof first.title === 'string' && first.title !== '' ? { title: first.title } : {}),
                content: first.text,
            },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map