import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
const CREDENTIAL = 'MINIMAX_API_KEY';
const DEFAULT_BASE_URL = 'https://api.minimax.io';
/** Moderation / plan-scope envelope codes that are not quota: no flags, surfaced prominently. */
const OUR_PROBLEM_CODES = new Set([1002, 1039, 1026, 1027, 2061]);
function authHeaders(ctx, credentialName) {
    const key = ctx.credentials.get(credentialName);
    if (key === null)
        throw new Error(`${credentialName} is missing; the routing layer should have excluded this provider`);
    return { authorization: `Bearer ${key}` };
}
function baseUrl(ctx, id) {
    const raw = ctx.config.account['base_url'];
    if (typeof raw === 'string' && raw !== '') {
        return raw.replace(/\/+$/, '');
    }
    // Region-aware fallback: the config parser materializes explicit account fields only, so
    // an emptied `account: {}` must still land on the id's own regional host (CN twin → CN).
    return id === 'minimax_cn' ? 'https://api.minimax.cn' : DEFAULT_BASE_URL;
}
export function minimaxAdapterFor(id) {
    return minimaxAdapterForRegion(id);
}
function minimaxAdapterForRegion(id) {
    // Four base urls → four credential variables: keys are NOT interchangeable across regions
    // (owner ruling after the region-split review); the CN twin keeps the existing export.
    const credentialName = id === 'minimax_cn' ? 'MINIMAX_API_KEY' : 'MINIMAX_GLOBAL_API_KEY';
    return {
        id,
        capabilities: ['search'],
        schema: {
            id,
            requiresCredentials: true,
            // Consumption depends on an account-side subscription/prepaid setup the skill cannot
            // verify (minimax plan key, zhipu resource pack, deepseek per-call billing). Fresh
            // installs must not call it until the owner enables it in the config.
            defaultEnabled: false,
            credentialNames: [credentialName],
            accountOptions: {
                base_url: {
                    type: 'string',
                    default: id === 'minimax_cn' ? 'https://api.minimax.cn' : DEFAULT_BASE_URL,
                    description: 'MiniMax REST host; cn-region accounts may use https://api.minimax.cn',
                },
            },
        },
        errorHints: {
            // Verified quota codes extracted from `base_resp.status_code` on an HTTP-200 envelope.
            quotaErrorCodes: ['1028', '1030'],
        },
        init(_account) {
            return {
                version: 1,
                canCharge: true,
                // Dual 5h+7d windows are not representable; exhaustion is durable until an external event.
                quotaPeriod: 'none',
                dayLimit: null,
                monthLimit: null,
                unit: 'plan-requests',
                resetTimezone: 'UTC',
            };
        },
        usageOf() {
            return 1;
        },
        /**
         * Lane A: after a quota refusal the engine may probe this read endpoint once per window.
         * Returns the vendor-declared boundary (`general` row's `end_time`) when that value lies in
         * the future; anything unusable degrades to null (QUOTA_UNKNOWN instead of a guess).
         */
        async probeReset(ctx) {
            const result = await request(ctx.fetchImpl, `${baseUrl(ctx, id)}/v1/token_plan/remains`, {
                method: 'GET',
                headers: authHeaders(ctx, credentialName),
            });
            if (!result.ok)
                return null;
            const parsed = parseJson(result.data.body);
            if (parsed === null)
                return null;
            const general = (parsed.model_remains ?? []).find((r) => r?.model_name === 'general');
            const endTime = typeof general?.end_time === 'number' ? general.end_time : Number(general?.end_time);
            if (!Number.isFinite(endTime) || endTime <= ctx.now())
                return null;
            return endTime;
        },
        async search(ctx, req) {
            const result = await request(ctx.fetchImpl, `${baseUrl(ctx, id)}/v1/coding_plan/search`, {
                method: 'POST',
                headers: authHeaders(ctx, credentialName),
                json: { q: req.query },
            });
            if (!result.ok)
                return result;
            const verdict = interpret(result.data, this.errorHints, ctx.now());
            if (verdict.kind !== 'success')
                return { ok: false, classification: verdict };
            const parsed = parseJson(result.data.body);
            if (parsed === null)
                return { ok: false, classification: classifyParseFailure('minimax search body is not JSON') };
            // A 200 envelope can still carry an error. Verified quota codes are handled by the hints;
            // other known non-quota codes (and unknown codes) are "our problem": no flags set, next
            // provider takes over, and the reason is surfaced prominently.
            const code = parsed.base_resp?.status_code;
            if (typeof code === 'number' && code !== 0) {
                if (OUR_PROBLEM_CODES.has(code) || !Number.isInteger(code)) {
                    return {
                        ok: false,
                        classification: {
                            kind: 'our_problem',
                            evidence: `minimax envelope status_code=${code} (${parsed.base_resp?.status_msg ?? 'no message'})`,
                        },
                    };
                }
                return {
                    ok: false,
                    classification: {
                        kind: 'our_problem',
                        evidence: `minimax envelope status_code=${code}; not a verified quota or moderation code`,
                    },
                };
            }
            const hits = (parsed.organic ?? [])
                .filter((r) => typeof r?.link === 'string')
                .map((r) => ({
                title: r.title ?? '',
                url: r.link,
                ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
            }));
            return { ok: true, data: hits, usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
        },
    };
}
;
export const minimaxAdapter = minimaxAdapterFor('minimax');
export const minimaxCnAdapter = minimaxAdapterFor('minimax_cn');
//# sourceMappingURL=index.js.map