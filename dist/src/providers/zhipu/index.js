import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'ZHIPU_API_KEY';
const MAX_COUNT = 50;
const MAX_QUERY_CHARS = 70;
function authHeaders(ctx, credentialName) {
    const key = ctx.credentials.get(credentialName);
    if (key === null)
        throw new Error(`${credentialName} is missing; the routing layer should have excluded this provider`);
    return { authorization: `Bearer ${key}` };
}
/**
 * Lane A in-band: the verified `1308` refusal carries the vendor's own reset time inside its
 * message ("您的限额将在 <time> 重置", Beijing time). Extracting it here means every refusal
 * records the recovery boundary with zero extra requests.
 */
function declaredResetAt(body) {
    if (body === undefined)
        return undefined;
    const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(body);
    if (match === null)
        return undefined;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : undefined;
}
function baseUrl(ctx, fallback) {
    const raw = ctx.config.account['base_url'];
    if (typeof raw === 'string' && raw !== '')
        return raw.replace(/\/+$/, '');
    return fallback;
}
export function zhipuAdapterFor(id, opts) {
    return zhipuAdapterForRegion(id, opts.defaultBaseUrl, opts.defaultEngine);
}
function zhipuAdapterForRegion(id, defaultHost, defaultEngine) {
    // Four base urls → four credential variables; z.ai keys are minted on the z.ai console and
    // are NOT interchangeable with bigmodel.cn keys (region-split review ruling).
    const credentialName = id === 'zhipu' ? 'ZAI_API_KEY' : 'ZHIPU_API_KEY';
    return {
        id,
        capabilities: ['search', 'fetch'],
        schema: {
            id,
            requiresCredentials: true,
            // Consumption depends on an account-side subscription/prepaid setup the skill cannot
            // verify (minimax plan key, zhipu resource pack, deepseek per-call billing). Fresh
            // installs must not call it until the owner enables it in the config.
            defaultEnabled: false,
            credentialNames: [credentialName],
            // Region switch: CN by default (open.bigmodel.cn carries the standalone REST tool
            // endpoint); overseas z.ai accounts override via this config field. Same body/auth/shape.
            accountOptions: {
                base_url: {
                    type: 'string',
                    default: defaultHost,
                    description: 'Region switch; semantics identical, only the host and default engine differ',
                },
            },
        },
        errorHints: {
            // Verified: these business codes are the auth failures of this platform (HTTP 401 family).
            authErrorCodes: ['1000', '1001', '1003', '1005'],
            // Verified: an in-band quota cap (message carries the reset time) — a quota event.
            // Verified: these business codes are quota/balance semantics of this platform — the
            // in-band cap (carries a reset time) and the arrears state (1113, live-verified 2026-11-02).
            quotaErrorCodes: ['1308', '1113'],
        },
        init(_account) {
            return {
                version: 1,
                canCharge: true,
                // Concurrency-based limiting; the cap error carries its own in-band reset time and no
                // vendor-declared calendar period fits here.
                quotaPeriod: 'none',
                dayLimit: null,
                monthLimit: null,
                unit: 'calls',
                resetTimezone: 'UTC',
            };
        },
        usageOf() {
            return 1;
        },
        async search(ctx, req) {
            const count = req.maxResults === undefined ? undefined : Math.min(MAX_COUNT, Math.max(1, req.maxResults));
            const result = await request(ctx.fetchImpl, `${baseUrl(ctx, defaultHost)}/web_search`, {
                method: 'POST',
                headers: authHeaders(ctx, credentialName),
                json: {
                    // Hardcoded request shape: base engine, no intent pre-recognition (extra latency).
                    search_query: req.query.slice(0, MAX_QUERY_CHARS),
                    search_engine: defaultEngine,
                    search_intent: false,
                    ...(count === undefined ? {} : { count }),
                },
            });
            if (!result.ok)
                return result;
            const verdict = interpret(result.data, this.errorHints, ctx.now());
            if (verdict.kind !== 'success') {
                if (verdict.kind === 'quota' && verdict.period === null) {
                    const resetAt = declaredResetAt(result.data.body);
                    if (resetAt !== undefined)
                        return { ok: false, classification: { ...verdict, resetAt } };
                }
                return { ok: false, classification: verdict };
            }
            const parsed = parseJson(result.data.body);
            if (parsed === null)
                return { ok: false, classification: classifyParseFailure('zhipu search body is not JSON') };
            const hits = (parsed.search_result ?? [])
                .filter((r) => typeof r?.link === 'string')
                .map((r) => ({
                title: r.title ?? '',
                url: r.link,
                ...(typeof r.content === 'string' ? { snippet: r.content } : {}),
            }));
            return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
        },
        async fetch(ctx, req) {
            const result = await request(ctx.fetchImpl, `${baseUrl(ctx, defaultHost)}/reader`, {
                method: 'POST',
                headers: authHeaders(ctx, credentialName),
                json: { url: req.url },
            });
            if (!result.ok)
                return result;
            const verdict = interpret(result.data, this.errorHints, ctx.now());
            if (verdict.kind !== 'success') {
                if (verdict.kind === 'quota' && verdict.period === null) {
                    const resetAt = declaredResetAt(result.data.body);
                    if (resetAt !== undefined)
                        return { ok: false, classification: { ...verdict, resetAt } };
                }
                return { ok: false, classification: verdict };
            }
            const parsed = parseJson(result.data.body);
            if (parsed === null)
                return { ok: false, classification: classifyParseFailure('zhipu reader body is not JSON') };
            const rr = parsed.reader_result;
            const content = rr?.content;
            if (rr === undefined || typeof content !== 'string') {
                return {
                    ok: false,
                    classification: {
                        kind: 'our_problem',
                        evidence: 'zhipu reader returned no content field in a 2xx response',
                    },
                };
            }
            return {
                ok: true,
                data: {
                    url: typeof rr.url === 'string' && rr.url !== '' ? rr.url : req.url,
                    ...(typeof rr.title === 'string' && rr.title !== '' ? { title: rr.title } : {}),
                    content,
                },
                usage: this.usageOf?.('fetch', ctx.config.account) ?? 1,
            };
        },
    };
}
;
export const zhipuAdapter = zhipuAdapterFor('zhipu', { defaultBaseUrl: 'https://api.z.ai/api/paas/v4', defaultEngine: 'search-prime' });
export const zhipuCnAdapter = zhipuAdapterFor('zhipu_cn', { defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultEngine: 'search_std' });
//# sourceMappingURL=index.js.map