/**
 * Adapter-level tests for the you.com and tinyfish adapters: request shape and response
 * mapping against mocked fetch. Pins stay provider-specific only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youAdapter } from '../src/providers/you/index.js';
import { tinyfishAdapter } from '../src/providers/tinyfish/index.js';
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
function runCapability(adapter, cap, ctx, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
req) {
    const method = cap === 'search' ? adapter.search : adapter.fetch;
    assert.ok(method !== undefined, `adapter must implement ${cap}`);
    return method.bind(adapter)(ctx, req);
}
// ---------------------------------------------------------------------------
// You.com
// ---------------------------------------------------------------------------
test('you search POSTs to ydc-index.io/v1/search with X-API-Key and count', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: { web: [{ title: 'T', url: 'https://y', description: 'D' }], knowledge: [] } } },
    ]);
    const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q', maxResults: 5 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://y', snippet: 'D' }]);
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls[0].url, 'https://ydc-index.io/v1/search');
    assert.equal(calls[0].headers['x-api-key'], 'fake-value-for-YDC_API_KEY');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'q', count: 5 });
});
test('you search falls back to the first snippet when description is absent', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: { web: [{ title: '', url: 'https://y2', snippets: ['s0', 's1'] }] } } },
    ]);
    const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q' });
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: '', url: 'https://y2', snippet: 's0' }]);
});
test('you fetch accepts the contents array and prefers markdown', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: [{ url: 'https://x', title: 'P', html: '<p>x</p>', markdown: '# p' }] },
    ]);
    const outcome = await runCapability(youAdapter, 'fetch', ctx, { url: 'https://x' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const doc = outcome.data;
        assert.deepEqual(doc, { url: 'https://x', title: 'P', content: '# p' });
    }
    assert.equal(calls[0].url, 'https://ydc-index.io/v1/contents');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { urls: ['https://x'], formats: ['markdown'] });
});
test('you billing semantics: credit-based, paid-gated, no reset window', () => {
    const init = youAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'none');
    assert.deepEqual(youAdapter.capabilities, ['search', 'fetch']);
});
// ---------------------------------------------------------------------------
// TinyFish
// ---------------------------------------------------------------------------
test('tinyfish search GETs the dedicated host with query', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { query: 'q', results: [{ title: 'T', url: 'https://tf', snippet: 'S' }], total_results: 10, page: 0 } },
    ]);
    const outcome = await runCapability(tinyfishAdapter, 'search', ctx, { query: 'q', maxResults: 20 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://tf', snippet: 'S' }]);
    }
    assert.equal(calls[0].method, 'GET');
    assert.equal(new URL(calls[0].url).origin, 'https://api.search.tinyfish.ai');
    assert.equal(new URL(calls[0].url).searchParams.get('query'), 'q');
    assert.equal(calls[0].headers['x-api-key'], 'fake-value-for-TINYFISH_API_KEY');
});
test('tinyfish fetch carries per-URL failures inside a 200 body', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [], errors: [{ url: 'https://f', error: 'target_http_error', status: 500 }] } },
    ]);
    const outcome = await runCapability(tinyfishAdapter, 'fetch', ctx, { url: 'https://f' });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
        assert.equal(outcome.classification.kind, 'our_problem');
        assert.match(outcome.classification.evidence, /target_http_error/);
    }
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { urls: ['https://f'], format: 'markdown' });
});
test('tinyfish fetch maps the successful document', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [{ url: 'https://r', title: 'TT', text: '# body' }] } },
    ]);
    const outcome = await runCapability(tinyfishAdapter, 'fetch', ctx, { url: 'https://r' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const doc = outcome.data;
        assert.deepEqual(doc, { url: 'https://r', title: 'TT', content: '# body' });
    }
});
test('you 429 with spend_cap_exceeded is durable quota, not a retryable cooldown', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 429, body: { error: { code: 'spend_cap_exceeded', message: 'key cap reached' }, limit: 100, used: 100 } },
    ]);
    const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q' });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
        assert.equal(outcome.classification.kind, 'quota');
        assert.equal(outcome.classification.period, null);
    }
});
test('you 429 without spend caps stays a short-window rate limit', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 429, body: { detail: 'Too many requests' } }]);
    const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q' });
    if (!outcome.ok)
        assert.equal(outcome.classification.kind, 'rate_limited_short');
});
test('tinyfish fetch evidence passes provider error text through the redactor', async () => {
    const leak = 'http://user:secret-hunter@blocked.example.com/x';
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [], errors: [{ url: 'https://f', error: `upstream rejected ${leak}` }] } },
    ]);
    const outcome = await runCapability(tinyfishAdapter, 'fetch', ctx, { url: 'https://f' });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
        assert.equal(outcome.classification.kind, 'our_problem');
        assert.ok(!outcome.classification.evidence.includes('secret-hunter'), 'provider-controlled text must be redacted');
    }
});
test('tinyfish quota semantics: paid-gated daily allowances, not locally countable', () => {
    const init = tinyfishAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'day');
    assert.equal(init.dayLimit, null, 'per-capability allowances cannot share one provider-level dayLimit');
    assert.deepEqual(tinyfishAdapter.capabilities, ['search', 'fetch']);
});
//# sourceMappingURL=providers-you-tinyfish.test.js.map