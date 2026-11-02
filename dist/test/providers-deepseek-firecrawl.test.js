/**
 * Adapter-level tests for the deepseek and firecrawl adapters: request shape and response
 * mapping against mocked fetch. The shared harness is intentionally duplicated from the
 * brave/minimax suite so each provider suite stays readable and independently runnable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepseekAdapter } from '../src/providers/deepseek/index.js';
import { firecrawlAdapter } from '../src/providers/firecrawl/index.js';
const CREDENTIALS = {
    has: () => true,
    get: (name) => `fake-value-for-${name}`,
    fingerprint: () => 'fake-fingerprint',
    describe: (names) => names.map((n) => ({ name: n, present: true })),
};
function lowercaseHeaders(input) {
    const out = {};
    for (const [key, value] of Object.entries(input))
        out[key.toLowerCase()] = value;
    return out;
}
function makeResponse(spec) {
    const entries = Object.entries(lowercaseHeaders(spec.headers ?? {}));
    const headerViews = {
        forEach: (cb) => {
            for (const [key, value] of entries)
                cb(value, key);
        },
    };
    const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return { status: spec.status, headers: headerViews, text: async () => body };
}
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
        return makeResponse(spec);
    };
    return {
        credentials: CREDENTIALS,
        config: { id: 'test', enabled: true, priority: 10, credentials: [], account, allowPaid: null },
        fetchImpl,
        now: () => 1_700_000_000_000,
        credentialNames: [],
    };
}
/** Calls an adapter's optional capability method, asserting it exists. */
function runCapability(adapter, cap, ctx, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
req) {
    const method = cap === 'search' ? adapter.search : adapter.fetch;
    assert.ok(method !== undefined, `adapter must implement ${cap}`);
    return method.bind(adapter)(ctx, req);
}
// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------
test('deepseek search posts the query with count mapping', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [{ title: 'T', url: 'https://d', snippet: 'sn', summary: 'sm' }] } },
    ]);
    const outcome = await runCapability(deepseekAdapter, 'search', ctx, { query: 'q', maxResults: 7 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://d', snippet: 'sm' }]);
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(calls[0].headers.authorization, 'Bearer fake-value-for-DEEPSEEK_API_KEY');
    const body = JSON.parse(calls[0].body ?? '{}');
    assert.deepEqual(body, { query: 'q', need_content: false, count: 7 });
});
test('deepseek fetch maps the content document', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 200, body: { title: 'P', content: '# md' } }]);
    const outcome = await runCapability(deepseekAdapter, 'fetch', ctx, { url: 'https://x' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const doc = outcome.data;
        assert.deepEqual(doc, { url: 'https://x', title: 'P', content: '# md' });
    }
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { url: 'https://x' });
});
test('deepseek billing semantics: paid-gated, no periodic quota', () => {
    const init = deepseekAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'none');
    assert.equal(init.dayLimit, null);
    assert.equal(deepseekAdapter.capabilities.includes('fetch'), true);
});
// ---------------------------------------------------------------------------
// Firecrawl
// ---------------------------------------------------------------------------
test('firecrawl search posts limits and maps data.web', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { success: true, data: { web: [{ title: 'W', description: 'D', url: 'https://f' }] }, creditsUsed: 2 } },
    ]);
    const outcome = await runCapability(firecrawlAdapter, 'search', ctx, { query: 'q', maxResults: 30 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'W', url: 'https://f', snippet: 'D' }]);
        assert.equal(outcome.usage, 2, 'search is billed as a 10-result block of 2 credits');
    }
    assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'q', limit: 30 });
});
test('firecrawl fetch prefers markdown and falls back through formats', async () => {
    for (const [fields, expected] of [
        [{ markdown: 'md', html: '<p>x</p>' }, 'md'],
        [{ html: '<p>x</p>' }, '<p>x</p>'],
        [{ rawHtml: '<p>y</p>' }, '<p>y</p>'],
    ]) {
        const calls = [];
        const ctx = makeContext(calls, [{ status: 200, body: { success: true, data: { ...fields, metadata: { title: 't', sourceURL: 'https://s' } } } }]);
        const outcome = await runCapability(firecrawlAdapter, 'fetch', ctx, { url: 'https://u/other' });
        assert.equal(outcome.ok, true);
        if (outcome.ok) {
            const doc = outcome.data;
            assert.equal(doc.content, expected);
            assert.equal(doc.url, 'https://s', 'metadata.sourceURL wins over the request URL');
            assert.equal(outcome.usage, 1);
        }
    }
});
test('firecrawl billing semantics: paid-gated monthly credits', () => {
    const init = firecrawlAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'month');
    assert.equal(init.monthLimit, 1_000);
    assert.equal(init.unit, 'credits');
});
//# sourceMappingURL=providers-deepseek-firecrawl.test.js.map