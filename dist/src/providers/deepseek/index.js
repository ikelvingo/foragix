import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'DEEPSEEK_API_KEY';
const BASE_URL = 'https://api.deepseek.com';
const MAX_COUNT = 50;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('DEEPSEEK_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
export const deepseekAdapter = {
    id: 'deepseek',
    capabilities: ['search', 'fetch'],
    schema: {
        id: 'deepseek',
        requiresCredentials: true,
        // Consumption depends on an account-side subscription/prepaid setup the skill cannot
        // verify (minimax plan key, zhipu resource pack, deepseek per-call billing). Fresh
        // installs must not call it until the owner enables it in the config.
        defaultEnabled: false,
        credentialNames: [CREDENTIAL],
        accountOptions: {},
    },
    errorHints: {
    // Verified per the official error table: fetch 404 means "no usable page content"
    // (site policy / unsupported content type), not a transport failure — no flags, next provider.
    // 403 on fetch is a security-policy rejection — the same treatment.
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            // Per-request billing; no free-tier quota and no vendor reset window to track.
            quotaPeriod: 'none',
            dayLimit: null,
            monthLimit: null,
            unit: 'successful-requests',
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/tools/search`, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: {
                query: req.query,
                need_content: false,
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
            return { ok: false, classification: classifyParseFailure('deepseek search body is not JSON') };
        const hits = (parsed.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            // `summary` is the model-facing text; fall back to `snippet`.
            ...(typeof r.summary === 'string' && r.summary !== '' ? { snippet: r.summary } : typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
    async fetch(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/v1/tools/fetch`, {
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
            return { ok: false, classification: classifyParseFailure('deepseek fetch body is not JSON') };
        if (typeof parsed.content !== 'string') {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: 'deepseek fetch returned no content field in a 2xx response',
                },
            };
        }
        return {
            ok: true,
            data: {
                url: req.url,
                ...(typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {}),
                content: parsed.content,
            },
            usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
        };
    },
};
//# sourceMappingURL=index.js.map