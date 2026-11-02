import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const DEFAULT_BASE_URL = 'https://search.ikelvin.space:8443';
function baseUrl(ctx) {
    const raw = ctx.config.account['base_url'];
    if (typeof raw === 'string' && raw !== '')
        return raw.replace(/\/+$/, '');
    return DEFAULT_BASE_URL;
}
export const searxngAdapter = {
    id: 'searxng',
    capabilities: ['search'],
    schema: {
        id: 'searxng',
        credentialNames: [],
        accountOptions: {
            base_url: {
                type: 'string',
                default: DEFAULT_BASE_URL,
                description: 'The self-hosted SearXNG instance base URL',
            },
        },
    },
    init(_account) {
        return {
            version: 1,
            canCharge: false,
            // No platform quota exists; upstream-engine pressure is not a locally countable quota.
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
        const url = new URL(`${baseUrl(ctx)}/search`);
        url.searchParams.set('q', req.query);
        url.searchParams.set('format', 'json');
        // Deliberately plain headers: the limiter derives the client IP from its own socket,
        // and forged X-Forwarded-For values make bot detection misbehave.
        const result = await request(ctx.fetchImpl, url.toString(), { method: 'GET' });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('searxng search body is not JSON') };
        const hits = (parsed.results ?? [])
            .filter((r) => typeof r?.url === 'string')
            .map((r) => ({
            title: r.title ?? '',
            url: r.url,
            ...(typeof r.content === 'string' ? { snippet: r.content } : {}),
        }));
        // Health signal per the admin docs: 200 with zero results while every engine refused
        // the instance is upstream degradation, not a legitimately empty match.
        if (hits.length === 0 && (parsed.unresponsive_engines ?? []).length > 0) {
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `searxng returned no results with ${parsed.unresponsive_engines?.length} unresponsive engine(s)`,
                },
            };
        }
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
};
//# sourceMappingURL=index.js.map