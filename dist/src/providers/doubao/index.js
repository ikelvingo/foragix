import { interpret, parseJson, request } from '../http.js';
import { classifyParseFailure } from '../../errors/classify.js';
import { redact } from '../../errors/redact.js';
const CREDENTIAL = 'DOUBAO_SEARCH_API_KEY';
const BASE_URL = 'https://open.feedcoopapi.com/search_api';
function authHeaders(ctx) {
    const key = ctx.credentials.get(CREDENTIAL);
    if (key === null)
        throw new Error('DOUBAO_SEARCH_API_KEY is missing; the routing layer should have excluded this provider');
    return { authorization: `Bearer ${key}` };
}
/** Maps one envelope error to a classification; error text is provider-controlled. */
function envelopeError(err) {
    return {
        ok: false,
        classification: {
            kind: 'our_problem',
            evidence: `doubao envelope error ${err?.Code ?? 'unknown'} (${redact(err?.Message ?? 'no message', 80)})`,
        },
    };
}
export const doubaoAdapter = {
    id: 'doubao',
    capabilities: ['search', 'information'],
    schema: {
        id: 'doubao',
        requiresCredentials: true,
        credentialNames: [CREDENTIAL],
        accountOptions: {
            version: {
                type: 'string',
                allowedValues: ['global', 'custom'],
                default: 'global',
                description: 'global = token-counted long-index variant; custom = richer-content variant (Count applies)',
            },
        },
    },
    init(_account) {
        return {
            version: 1,
            canCharge: true,
            quotaPeriod: 'month',
            dayLimit: null,
            monthLimit: 500,
            unit: 'searches',
            resetTimezone: 'UTC',
        };
    },
    usageOf() {
        return 1;
    },
    async information(ctx, req) {
        const result = await request(ctx.fetchImpl, `${BASE_URL}/web_search`, {
            method: 'POST', headers: authHeaders(ctx), json: { Query: req.query, SearchType: 'web' },
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('doubao information body is not JSON') };
        if (parsed.ResponseMetadata?.Error !== undefined)
            return envelopeError(parsed.ResponseMetadata.Error);
        if (parsed.Result === null || parsed.Result === undefined) {
            return { ok: false, classification: classifyParseFailure('doubao information body is not a valid result') };
        }
        const cards = Array.isArray(parsed.Result.CardResults) ? parsed.Result.CardResults : [];
        if (cards.length > 0)
            return { ok: true, data: { type: 'card', source: 'doubao', data: cards }, usage: 1 };
        const ruyi = (parsed.Result.WebResults ?? []).filter((item) => item?.RuyiInfo != null);
        if (ruyi.length > 0)
            return { ok: true, data: { type: 'ruyi', source: 'doubao', data: ruyi }, usage: 1 };
        return { ok: true, data: { type: 'card', source: 'doubao', data: [] }, usage: 1 };
    },
    async search(ctx, req) {
        const version = ctx.config.account['version'] === 'custom' ? 'custom' : 'global';
        const count = req.maxResults === undefined ? undefined : Math.min(50, Math.max(1, req.maxResults));
        const endpoint = version === 'custom' ? `${BASE_URL}/web_search` : `${BASE_URL}/global_search`;
        const body = version === 'custom'
            ? {
                Query: req.query,
                SearchType: 'web',
                ...(count === undefined ? {} : { Count: count }),
            }
            : {
                query: req.query,
                ...(count === undefined ? {} : { doc_count: count }),
            };
        const result = await request(ctx.fetchImpl, endpoint, {
            method: 'POST',
            headers: authHeaders(ctx),
            json: body,
        });
        if (!result.ok)
            return result;
        const verdict = interpret(result.data, this.errorHints, ctx.now());
        if (verdict.kind !== 'success')
            return { ok: false, classification: verdict };
        if (version === 'custom') {
            const parsed = parseJson(result.data.body);
            if (parsed === null)
                return { ok: false, classification: classifyParseFailure('doubao search body is not JSON') };
            const err = parsed.ResponseMetadata?.Error;
            if (err !== undefined)
                return envelopeError(err);
            const webResults = parsed.Result?.WebResults ?? [];
            const hits = webResults
                .filter((r) => typeof r?.Url === 'string')
                .map((r) => ({
                title: r.Title ?? '',
                url: r.Url,
                ...(typeof r.Content === 'string' && r.Content !== ''
                    ? { snippet: r.Content }
                    : typeof r.Summary === 'string' && r.Summary !== ''
                        ? { snippet: r.Summary }
                        : typeof r.PublishTime === 'string'
                            ? { snippet: r.PublishTime }
                            : {}),
            }));
            return { ok: true, data: hits.slice(0, count ?? hits.length), usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
        }
        const parsed = parseJson(result.data.body);
        if (parsed === null)
            return { ok: false, classification: classifyParseFailure('doubao search body is not JSON') };
        const err = parsed.ResponseMetadata?.Error;
        if (err !== undefined)
            return envelopeError(err);
        const docs = parsed.Result?.Documents ?? [];
        const hits = docs
            .filter((d) => typeof d?.Url === 'string')
            .map((d) => ({
            title: d.Title ?? '',
            url: d.Url,
            ...(Array.isArray(d.Snippet) ? { snippet: d.Snippet.filter((s) => s.Type === 'text' && typeof s.Text === 'string').map((s) => s.Text).join(' ') } : {}),
        }));
        return { ok: true, data: hits.slice(0, count ?? hits.length), usage: this.usageOf?.('search', ctx.config.account) ?? 1 };
    },
};
//# sourceMappingURL=index.js.map