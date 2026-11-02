import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
const CREDENTIAL = 'ZHIHU_API_KEY';
const BASE_URL = 'https://developer.zhihu.com/api/v1/content';
const MAX_COUNT = 20;
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('ZHIHU_API_KEY is missing; the routing layer should have excluded this provider');
    // The platform verifies a per-request unix-seconds timestamp alongside the secret.
    return { authorization: `Bearer ${key}`, 'x-request-timestamp': String(Math.floor(ctx.now() / 1000)) };
}
export const zhihuAdapter = {
    id: 'zhihu',
    capabilities: ['search'],
    schema: {
        id: 'zhihu',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {
            db: {
                type: 'string',
                allowedValues: ['zhihu', 'global'],
                default: 'zhihu',
                description: 'zhihu = 知乎站内搜索接口; global = 全网搜索接口 (SearchDB=realtime|static|all)',
            },
        },
    },
    init(_account) {
        const raw = _account['db'];
        const isGlobal = raw === 'global';
        return {
            version: 1,
            canCharge: false,
            quotaPeriod: 'day',
            dayLimit: 5_000,
            monthLimit: null,
            unit: 'calls',
            resetTimezone: 'UTC',
            ...(isGlobal ? {} : {}),
        };
    },
    usageOf() {
        return 1;
    },
    async search(ctx, req) {
        const account = ctx.config.account;
        const kind = account['db'] === 'global' ? 'global_search' : 'zhihu_search';
        const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
        const url = new URL(`${BASE_URL}/${kind}`);
        url.searchParams.set('Query', req.query);
        if (count !== undefined)
            url.searchParams.set('Count', String(count));
        if (kind === 'global_search')
            url.searchParams.set('SearchDB', 'all');
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
            return { ok: false, classification: classifyParseFailure('zhihu search body is not JSON') };
        if (typeof parsed.Code === 'number' && parsed.Code !== 0) {
            // Since the envelope arrives on HTTP 200, the hints cannot match it (a capitalized
            // Code key is not tested by the extractor); semantics are verified per-code.
            if (parsed.Code === 20001) {
                // Verified live: an authentication failure of the Access Secret.
                return {
                    ok: false,
                    classification: { kind: 'credential_rejected', evidence: 'zhihu envelope Code=20001 (access-secret rejected)' },
                };
            }
            return {
                ok: false,
                classification: {
                    kind: 'our_problem',
                    evidence: `zhihu envelope Code=${parsed.Code} (${redact(parsed.Message ?? 'no message', 80)})`,
                },
            };
        }
        const hits = (parsed.Data?.Items ?? [])
            .filter((r) => typeof r?.Url === 'string')
            .map((r) => ({
            title: r.Title ?? '',
            url: r.Url,
            // <em> marks the query-hit highlights inside the vendor snippet; plain-text wins.
            ...(typeof r.ContentText === 'string' ? { snippet: r.ContentText.replaceAll(/<\/?em>/g, '') } : {}),
        }));
        return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
};
//# sourceMappingURL=index.js.map