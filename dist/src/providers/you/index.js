import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'YDC_API_KEY';
const BASE_URL = 'https://ydc-index.io';
const MAX_COUNT = 100;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('YDC_API_KEY is missing; the routing layer should have excluded this provider');
    return { 'x-api-key': key };
}
export const youAdapter = {
    id: 'you',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'you',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    // The 403 scope/wrong-host bodies are covered by the default "our problem" rule.
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            // Credit-based spend: no vendor reset window to track.
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
        const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                ...(count === undefined ? {} : { count }),
            },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success') {
            if (verdict.kind === 'rate_limited_short' && result.data.body.includes('spend_cap_exceeded')) {
                // Verified: a per-key spending cap is not lifted by waiting — treat as durable quota.
                return {
                    ok: false,
                    classification: {
                        kind: 'quota',
                        period: null,
                        evidence: 'you.com 429 spend_cap_exceeded — the spending cap is not lifted by retrying',
                    },
                };
            }
            return { ok: false, classification: verdict };
        }
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('you search body is not JSON') };
        const hits = (parsed.results?.web ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => {
            const snippet = typeof r.description === 'string' && r.description !== ''
                ? r.description
                : Array.isArray(r.snippets) && r.snippets.length > 0
                    ? r.snippets[0]
                    : undefined;
            return {
                title: r.title ?? '',
                url: r.url,
                ...(snippet === undefined ? {} : { snippet }),
            };
        });
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/contents`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: { urls: [req.url], formats: ['markdown'] },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success') {
            if (verdict.kind === 'rate_limited_short' && result.data.body.includes('spend_cap_exceeded')) {
                return {
                    ok: false,
                    classification: {
                        kind: 'quota',
                        period: null,
                        evidence: 'you.com 429 spend_cap_exceeded — the spending cap is not lifted by retrying',
                    },
                };
            }
            return { ok: false, classification: verdict };
        }
        const parsed = parseJson(result.data.body);
        if (parsed === null || !Array.isArray(parsed)) {
            return { ok: false, classification: classifyParseFailure('you contents body is not a JSON array') };
        }
        const item = parsed.find((entry) => typeof entry?.markdown === 'string' || typeof entry?.html === 'string');
        if (item === undefined) {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `you contents returned ${parsed.length} item(s) with no markdown/html content`,
                },
            };
        }
        const content = typeof item.markdown === 'string' && item.markdown !== '' ? item.markdown : item.html;
        return {
            ok: true,
            data: {
                url: req.url,
                ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
                content,
            },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map