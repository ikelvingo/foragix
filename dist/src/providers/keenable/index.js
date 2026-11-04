import { clampCooldown, classifyParseFailure, parseRetryAfter } from '../../errors/classify.js';
import { interpret, parseJson, request } from '../http.js';
const CREDENTIAL = 'KEENABLE_API_KEY';
const BASE_URL = 'https://api.keenable.ai';
const MAX_RESULTS = 50;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error(`${CREDENTIAL} is missing; the routing layer should have excluded this provider`);
    return { 'X-API-Key': key };
}
function classifyResponse(result, ctx) {
    // Keenable documents every 429 as a short-window rate limit. The generic body matcher sees
    // the word "exceeded" in "rate limit exceeded" and can misclassify it as monthly quota.
    if (result.status === 429) {
        const retryAfter = parseRetryAfter(result.headers['retry-after'] ?? null, ctx.now());
        return {
            kind: 'rate_limited_short',
            evidence: 'HTTP 429 Keenable rate limit',
            ...(retryAfter === null ? {} : { cooldownMs: clampCooldown(retryAfter) }),
        };
    }
    return interpret(result, keenableAdapter.errorHints, ctx.now());
}
export const keenableAdapter = {
    id: 'keenable',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'keenable',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    errorHints: {
        statusMap: {
            403: { kind: 'credential_rejected', evidence: 'HTTP 403 Keenable API key disabled or revoked' },
        },
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'month',
            dayLimit: null,
            monthLimit: 100_000,
            unit: 'requests',
            // The API specifies a monthly reset but no timezone; UTC is the local accounting convention.
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const maxResults = req.maxResults === undefined
            ? undefined
            : Math.min(MAX_RESULTS, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                ...(maxResults === undefined ? {} : { max_results: maxResults }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = classifyResponse(result.data, ctx);
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null || !Array.isArray(parsed.results)) {
            return { ok: false, classification: classifyParseFailure('keenable search body is not a results array') };
        }
        const hits = parsed.results
            .filter((item) => typeof item?.url === 'string')
            .map((item) => ({
            title: item.title ?? '',
            url: item.url,
            ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
        }));
        return { ok: true, data: hits, usage: 1 };
    },
    async fetch(ctx, req) {
        const url = new URL(`${BASE_URL}/v1/fetch`);
        url.searchParams.set('url', req.url);
        const result = await request(ctx.fetchImpl, url.toString(), {
            method: 'GET',
            headers: authHeaders(ctx),
        });
        if (!result.ok)
            return result;
        const verdict = classifyResponse(result.data, ctx);
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null || typeof parsed.url !== 'string' || typeof parsed.content !== 'string') {
            return { ok: false, classification: classifyParseFailure('keenable fetch body is missing url or content') };
        }
        return {
            ok: true,
            data: {
                url: parsed.url,
                ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
                content: parsed.content,
            },
            usage: 1,
        };
    },
};
//# sourceMappingURL=index.js.map