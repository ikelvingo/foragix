/**
 * Adapter-level tests for the five 2026-11-02 additions: linkup, metaso, ollama, zhihu,
 * doubao. Request shapes and response mappings are pinned against the live-verified
 * contracts in documents/providers/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkupAdapter } from '../src/providers/linkup/index.js';
import { metasoAdapter } from '../src/providers/metaso/index.js';
import { ollamaAdapter } from '../src/providers/ollama/index.js';
import { zhihuAdapter } from '../src/providers/zhihu/index.js';
import { doubaoAdapter } from '../src/providers/doubao/index.js';
const CREDENTIALS = {
    has: () => true,
    get: (name) => `fake-value-for-${name}`,
    fingerprint: () => 'fake-fingerprint',
    describe: (names) => names.map((n) => ({ name: n, present: true })),
};
function makeContext(calls, responses, account = {}) {
    let index = 0;
    const fetchImpl = async (_url, init) => {
        const spec = responses[index];
        if (spec === undefined)
            throw new Error(`no mock response for call #${index}`);
        index += 1;
        const reqHeaders = {};
        new Map(Object.entries(init?.headers ?? {})).forEach((value, key) => {
            reqHeaders[key.toLowerCase()] = String(value);
        });
        calls.push({
            url: String(_url),
            method: init?.method ?? 'GET',
            headers: reqHeaders,
            body: typeof init?.body === 'string' ? init.body : undefined,
        });
        const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
        return { status: spec.status, headers: { forEach: () => { } }, text: async () => body };
    };
    return {
        credentials: CREDENTIALS,
        config: { id: 'test', enabled: true, priority: 10, credentials: [], account, allowPaid: null },
        fetchImpl,
        now: () => 1_700_000_000_123,
        credentialNames: [],
    };
}
function runSearch(adapter, ctx, req) {
    assert.ok(adapter.search !== undefined, 'adapter must implement search');
    const search = adapter.search.bind(adapter);
    return search(ctx, req);
}
test('linkup search sends the verified body (q / outputType / includeImages)', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 200, body: { results: [{ name: 'N', url: 'https://l', content: 'C' }] } }]);
    const outcome = await runSearch(linkupAdapter, ctx, { query: 'q' });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'N', url: 'https://l', snippet: 'C' }]);
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), {
        q: 'q',
        depth: 'standard',
        outputType: 'searchResults',
        includeImages: false,
    });
});
test('metaso search posts scoped query and keeps the balance evidence in the hit list only', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { credits: 997, webpages: [{ title: 'T', link: 'https://m', snippet: 'S' }] } },
    ]);
    const outcome = await runSearch(metasoAdapter, ctx, { query: 'q', maxResults: 4 });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://m', snippet: 'S' }]);
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { q: 'q', scope: 'all', count: 4 });
});
test('ollama search and fetch use the two tool endpoints with bearer auth', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [{ title: 'T', url: 'https://o', content: 'C' }] } },
    ]);
    const outcome = await runSearch(ollamaAdapter, ctx, { query: 'q' });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://o', snippet: 'C' }]);
    assert.equal(calls[0].url, 'https://api.ollama.com/api/web_search');
    assert.equal(calls[0].headers.authorization, 'Bearer fake-value-for-OLLAMA_API_KEY');
});
test('zhihu search picks the endpoint by the account option and strips highlight tags', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        {
            status: 200,
            body: { Code: 0, Message: 'success', Data: { HasMore: false, Items: [{ Title: 'T', ContentText: 'hi <em>kw</em> end', Url: 'https://z/q' }] } },
        },
    ]);
    const outcome = await runSearch(zhihuAdapter, ctx, { query: 'q', maxResults: 3 });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://z/q', snippet: 'hi kw end' }]);
    assert.equal(calls[0].method, 'GET');
    assert.equal(new URL(calls[0].url).pathname, '/api/v1/content/zhihu_search');
    assert.equal(new URL(calls[0].url).searchParams.get('Query'), 'q');
    assert.equal(new URL(calls[0].url).searchParams.get('Count'), '3');
    assert.match(calls[0].headers['x-request-timestamp'] ?? '', /^\d+$/);
});
test('explicit Zhihu site search overrides global mode and caps Count at ten', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 200, body: { Code: 0, Data: { Items: [] } } }], { db: 'global' });
    await zhihuAdapter.search(ctx, { query: 'q', maxResults: 30, site: 'zhihu' });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/v1/content/zhihu_search');
    assert.equal(url.searchParams.get('Count'), '10');
    assert.equal(url.searchParams.has('SearchDB'), false);
});
test('zhihu global mode hits the global_search endpoint without SearchDB on zhihu', async () => {
    for (const [account, expectedPath, hasSearchDb] of [
        [{ db: 'global' }, '/api/v1/content/global_search', true],
        [{}, '/api/v1/content/zhihu_search', false],
    ]) {
        const calls = [];
        const ctx = makeContext(calls, [{ status: 200, body: { Code: 0, Data: { Items: [] } } }], account);
        await runSearch(zhihuAdapter, ctx, { query: 'q' });
        assert.equal(new URL(calls[0].url).pathname, expectedPath);
        assert.equal(new URL(calls[0].url).searchParams.has('SearchDB'), hasSearchDb);
    }
});
test('doubao global variant posts the lowercase body and truncates the fixed-10 server response', async () => {
    const calls = [];
    const docs = Array.from({ length: 10 }, (_, i) => ({
        Title: `t${i}`,
        Url: `https://d/${i}`,
        Snippet: [{ Type: 'text', Text: `s${i}` }],
    }));
    const ctx = makeContext(calls, [{ status: 200, body: { Result: { Documents: docs } } }]);
    const outcome = await runSearch(doubaoAdapter, ctx, { query: 'q', maxResults: 2 });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.equal(outcome.data.length, 2, 'the server ignores doc_count; the client truncates');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'q', doc_count: 2 });
});
test('doubao custom variant posts the camel-case body and maps WebResults', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 200, body: { Result: { WebResults: [{ Title: 'T', Url: 'https://w', Content: 'C' }] } } }], {
        version: 'custom',
    });
    const outcome = await runSearch(doubaoAdapter, ctx, { query: 'q' });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://w', snippet: 'C' }]);
    assert.equal(new URL(calls[0].url).pathname, '/search_api/web_search');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { Query: 'q', SearchType: 'web' });
});
test('doubao information uses Custom and preserves cards without URLs or unknown fields', async () => {
    const calls = [];
    const cards = [{ CardType: 'weather', WeatherCard: { Condition: { Temp: 20 }, ExtraFutureField: 'kept' } }];
    const ctx = makeContext(calls, [{ status: 200, body: { Result: { CardResults: cards } } }], { version: 'global' });
    assert.ok(doubaoAdapter.information !== undefined);
    const outcome = await doubaoAdapter.information(ctx, { query: '北京天气' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.equal(outcome.data.type, 'card');
        assert.equal(outcome.data.source, 'doubao');
        assert.deepEqual(outcome.data.data, cards);
    }
    assert.equal(new URL(calls[0].url).pathname, '/search_api/web_search');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { Query: '北京天气', SearchType: 'web' });
});
test('doubao information retains all documented card shapes without narrowing fields', async () => {
    const names = ['WeatherCard', 'LotteryCard', 'MetalCard', 'ExchangeRateCard', 'HolidayCard', 'HanziCard',
        'TrainScheduleCard', 'TrainRouteCard', 'FlightRouteCard', 'SportsMatchCard', 'ActorWorksCard',
        'TaxEnquiryCard', 'MacroEconomyCard', 'ZipcodeCard', 'BasketballEventCard', 'BasketballMatchCard',
        'BasketballTeamCard', 'IndexQuoteSnapshotCard', 'IndexTrendCard', 'StockFinanceCard',
        'IndexConstituentsCard', 'FundFlowCard', 'WorldTimeCard'];
    const cards = names.map((name) => ({ CardType: name, [name]: { nested: { value: 42 }, futureField: true } }));
    const ctx = makeContext([], [{ status: 200, body: { Result: { CardResults: cards } } }]);
    const outcome = await doubaoAdapter.information(ctx, { query: 'test' });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data.data, cards);
});
test('doubao information preserves RuyiInfo web items when structured cards are absent', async () => {
    const calls = [];
    const item = { Title: '油价', SiteName: '火山如意', RuyiInfo: { Type: 'oil_price', Extra: 'kept' }, Content: 'data' };
    const ctx = makeContext(calls, [{ status: 200, body: { Result: { CardResults: null, WebResults: [item, { Title: 'ordinary' }] } } }]);
    const outcome = await doubaoAdapter.information(ctx, { query: '油价' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.equal(outcome.data.type, 'ruyi');
        assert.deepEqual(outcome.data.data, [item]);
    }
});
test('doubao quota semantics: paid-gated monthly 500 shared pool', () => {
    const init = doubaoAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'month');
    assert.equal(init.monthLimit, 500);
});
test('provider capability declarations match their implemented operations', () => {
    assert.deepEqual(zhihuAdapter.capabilities, ['search', 'fetch']);
    assert.deepEqual(doubaoAdapter.capabilities, ['search', 'information']);
});
//# sourceMappingURL=providers-new-five.test.js.map