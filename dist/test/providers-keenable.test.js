import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, getAdapter, adapterIds } from '../src/providers/registry.js';
import { buildDefaultConfig } from '../src/config/defaults.js';
const CREDENTIALS = {
    has: () => true,
    get: () => 'fake-keenable-key',
    fingerprint: () => 'fake-fingerprint',
    describe: (names) => names.map((name) => ({ name, present: true })),
};
function makeContext(calls, responses) {
    let index = 0;
    const fetchImpl = async (rawUrl, init) => {
        const spec = responses[index];
        if (spec === undefined)
            throw new Error(`no mock response for call #${index}`);
        index += 1;
        const headers = {};
        new Map(Object.entries(init?.headers ?? {})).forEach((value, key) => {
            headers[key.toLowerCase()] = String(value);
        });
        calls.push({
            url: String(rawUrl),
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? init.body : undefined,
        });
        const entries = Object.entries(spec.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]);
        const responseHeaders = {
            forEach: (cb) => entries.forEach(([key, value]) => cb(value, key)),
        };
        const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
        return { status: spec.status, headers: responseHeaders, text: async () => body };
    };
    return {
        credentials: CREDENTIALS,
        config: {
            id: 'keenable',
            enabled: true,
            priority: 9,
            credentials: [{ name: 'KEENABLE_API_KEY', required: true }],
            account: {},
            allowPaid: null,
        },
        fetchImpl,
        now: () => 1_700_000_000_000,
        credentialNames: ['KEENABLE_API_KEY'],
    };
}
function adapter() {
    const found = getAdapter('keenable');
    assert.ok(found, 'keenable must be registered');
    return found;
}
test('keenable is registered with search and fetch and follows minimax_cn in default priority', () => {
    const provider = adapter();
    assert.deepEqual(provider.capabilities, ['search', 'fetch']);
    assert.deepEqual(provider.schema.credentialNames, ['KEENABLE_API_KEY']);
    assert.equal(provider.init({}).quotaPeriod, 'month');
    assert.equal(provider.init({}).monthLimit, 100_000);
    assert.equal(provider.schema.localCap, undefined);
    const ids = adapterIds();
    assert.ok(ids.indexOf('minimax_cn') >= 0);
    assert.equal(ids.indexOf('keenable'), ids.indexOf('minimax_cn') + 1);
    const priorities = new Map(buildDefaultConfig(ADAPTERS).providers.map((item) => [item.id, item.priority]));
    assert.ok((priorities.get('minimax_cn') ?? Number.POSITIVE_INFINITY) < (priorities.get('keenable') ?? -1));
    assert.ok((priorities.get('keenable') ?? Number.POSITIVE_INFINITY) < (priorities.get('searxng') ?? -1));
});
test('keenable search authenticates, clamps result count, and maps result snippets', async () => {
    const calls = [];
    const provider = adapter();
    assert.ok(provider.search);
    const outcome = await provider.search(makeContext(calls, [{
            status: 200,
            body: {
                query: 'typescript practices',
                mode: 'pro',
                results: [{ title: 'Guide', url: 'https://example.com/guide', snippet: 'A short guide', description: '' }],
            },
        }]), { query: 'typescript practices', maxResults: 100 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, [{ title: 'Guide', url: 'https://example.com/guide', snippet: 'A short guide' }]);
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.keenable.ai/v1/search');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['x-api-key'], 'fake-keenable-key');
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'typescript practices', max_results: 50 });
});
test('keenable search omits max_results when the caller leaves it unspecified', async () => {
    const calls = [];
    const provider = adapter();
    assert.ok(provider.search);
    const outcome = await provider.search(makeContext(calls, [{ status: 200, body: { results: [] } }]), { query: 'q' });
    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'q' });
});
test('keenable fetch encodes the URL and maps markdown content', async () => {
    const calls = [];
    const provider = adapter();
    assert.ok(provider.fetch);
    const pageUrl = 'https://example.com/page?a=1&b=two';
    const outcome = await provider.fetch(makeContext(calls, [{
            status: 200,
            body: { url: pageUrl, title: 'Fetched page', content: '# Markdown body' },
        }]), { url: pageUrl });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        assert.deepEqual(outcome.data, { url: pageUrl, title: 'Fetched page', content: '# Markdown body' });
        assert.equal(outcome.usage, 1);
    }
    assert.equal(calls[0].method, 'GET');
    assert.equal(new URL(calls[0].url).origin + new URL(calls[0].url).pathname, 'https://api.keenable.ai/v1/fetch');
    assert.equal(new URL(calls[0].url).searchParams.get('url'), pageUrl);
    assert.equal(calls[0].headers['x-api-key'], 'fake-keenable-key');
});
test('keenable maps 402 to quota, 401/403 to credential rejection, and 429 to short rate limit', async () => {
    const provider = adapter();
    assert.ok(provider.search);
    const call = (status, body = {}, headers) => provider.search(makeContext([], [{ status, body, ...(headers === undefined ? {} : { headers }) }]), { query: 'q' });
    const quota = await call(402, { message: 'monthly allowance spent and no credits available' });
    assert.equal(quota.ok, false);
    if (!quota.ok)
        assert.deepEqual(quota.classification, { kind: 'quota', period: null, evidence: 'HTTP 402 Payment Required' });
    for (const status of [401, 403]) {
        const auth = await call(status, { message: 'key disabled or invalid' });
        assert.equal(auth.ok, false);
        if (!auth.ok)
            assert.equal(auth.classification.kind, 'credential_rejected');
    }
    const limited = await call(429, { message: 'rate limit exceeded' }, { 'Retry-After': '2' });
    assert.equal(limited.ok, false);
    if (!limited.ok) {
        assert.equal(limited.classification.kind, 'rate_limited_short');
        if (limited.classification.kind === 'rate_limited_short')
            assert.equal(limited.classification.cooldownMs, 2_000);
    }
});
//# sourceMappingURL=providers-keenable.test.js.map