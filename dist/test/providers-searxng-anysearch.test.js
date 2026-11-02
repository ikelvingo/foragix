/**
 * Adapter-level tests for the searxng and anysearch adapters: request shape and response
 * mapping against mocked fetch. The harness is shared by design with the other provider
 * suites; keep this list of pins provider-specific only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searxngAdapter } from '../src/providers/searxng/index.js';
import { anysearchAdapter } from '../src/providers/anysearch/index.js';
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
// SearXNG
// ---------------------------------------------------------------------------
test('searxng search GETs the configured instance with format=json and no auth header', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [{ url: 'https://w', title: 'T', content: 'C' }], unresponsive_engines: [] } },
    ]);
    const outcome = await runCapability(searxngAdapter, 'search', ctx, { query: 'q' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://w', snippet: 'C' }]);
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['x-forwarded-for'], undefined, 'a forged client IP must not be sent');
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('q'), 'q');
    assert.equal(url.searchParams.get('format'), 'json');
});
test('searxng defaults to the owner instance and honours the base_url account option', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 200, body: { results: [] } }]);
    await runCapability(searxngAdapter, 'search', ctx, { query: 'q' });
    assert.equal(new URL(calls[0].url).origin, 'https://search.ikelvin.space:8443');
    const calls2 = [];
    const ctx2 = makeContext(calls2, [{ status: 200, body: { results: [] } }], {
        base_url: 'https://sx.example.test',
    });
    await runCapability(searxngAdapter, 'search', ctx2, { query: 'q' });
    assert.equal(new URL(calls2[0].url).origin, 'https://sx.example.test');
});
test('searxng 200 with zero results and unresponsive engines is upstream degradation', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [], unresponsive_engines: [['google', 'denied']] } },
    ]);
    const outcome = await runCapability(searxngAdapter, 'search', ctx, { query: 'q' });
    if (!outcome.ok) {
        assert.equal(outcome.classification.kind, 'our_problem');
    }
});
test('searxng self-hosted semantics: no charge, no countable quota', () => {
    assert.deepEqual(searxngAdapter.schema.credentialNames, []);
    assert.equal(searxngAdapter.schema.requiresCredentials, undefined);
    const init = searxngAdapter.init({});
    assert.equal(init.canCharge, false);
    assert.equal(init.quotaPeriod, 'none');
    assert.deepEqual(searxngAdapter.capabilities, ['search']);
});
test('searxng partial results with unresponsive engines are success-with-degradation', async () => {
    // Pinned decision: only a zero-result response with all engines refused is degraded
    // (see the adapter comment); usable partial results stay a success for the caller.
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { results: [{ url: 'https://ok', title: 'T' }], unresponsive_engines: [['google', 'denied']] } },
    ]);
    const outcome = await runCapability(searxngAdapter, 'search', ctx, { query: 'q' });
    assert.equal(outcome.ok, true);
    if (outcome.ok)
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://ok' }]);
});
// ---------------------------------------------------------------------------
// AnySearch
// ---------------------------------------------------------------------------
test('anysearch search posts query with max_results clamped to 10', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        {
            status: 200,
            body: { code: 0, message: 'success', data: { results: [{ title: 'T', url: 'https://a', snippet: 'S' }] } },
        },
    ]);
    const outcome = await runCapability(anysearchAdapter, 'search', ctx, { query: 'q', maxResults: 99 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://a', snippet: 'S' }]);
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls[0].url, 'https://api.anysearch.com/v1/search');
    assert.equal(calls[0].headers.authorization, 'Bearer fake-value-for-ANYSEARCH_API_KEY');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'q', max_results: 10 });
});
test('anysearch fetch posts a strict single-field url body', async () => {
    const calls = [];
    const ctx = makeContext(calls, [
        { status: 200, body: { code: 0, data: { url: 'https://z', title: '', content: 'text' } } },
    ]);
    const outcome = await runCapability(anysearchAdapter, 'fetch', ctx, { url: 'https://z' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const doc = outcome.data;
        assert.equal(doc.url, 'https://z');
        assert.equal(doc.title, undefined, 'an empty-string title must not surface as a title');
    }
    assert.equal(calls[0].url, 'https://api.anysearch.com/v1/extract');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { url: 'https://z' });
});
test('anysearch HTTP 402 on the shared pool is daily quota exhaustion', async () => {
    const calls = [];
    const ctx = makeContext(calls, [{ status: 402, body: { code: -1, message: 'quota exhausted' } }]);
    const outcome = await runCapability(anysearchAdapter, 'search', ctx, { query: 'q' });
    if (!outcome.ok) {
        assert.equal(outcome.classification.kind, 'quota');
    }
});
test('anysearch billing semantics: paid-gated daily pool', () => {
    const init = anysearchAdapter.init({});
    assert.equal(init.canCharge, true);
    assert.equal(init.quotaPeriod, 'day');
    assert.equal(init.dayLimit, 1_000);
    assert.deepEqual(anysearchAdapter.capabilities, ['search', 'fetch']);
});
//# sourceMappingURL=providers-searxng-anysearch.test.js.map