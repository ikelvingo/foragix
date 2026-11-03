import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteAdapter } from '../src/db/sqlite.js';
import { applySchema, writeSchemaVersion } from '../src/db/schema.js';
import { Engine } from '../src/engine.js';
import { parseConfig } from '../src/config/load.js';
import { loadCredentials } from '../src/credentials/load.js';
import { ADAPTERS, createSchemaLookup } from '../src/providers/registry.js';
import { BIT } from '../src/db/bits.js';
import { monthKey, DEFAULT_TIMEZONE } from '../src/db/period.js';
import { mergeDefaultProviders } from '../src/config/defaults.js';
import { readObserved } from '../src/state/usage.js';
const DDL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
/** Return a canned response by URL. Any URL that is not matched returns 500, so a test never silently depends on the real network. */
function fakeFetch(routes) {
    return (async (input) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);
        const route = routes[url];
        if (route === undefined)
            return new Response('unrouted', { status: 500 });
        return new Response(route.body, { status: route.status, headers: route.headers ?? {} });
    });
}
const TAVILY_SEARCH_OK = JSON.stringify({ results: [{ title: 'T', url: 'https://t.example' }] });
const EXA_SEARCH_OK = JSON.stringify({ results: [{ title: 'E', url: 'https://e.example' }] });
const CONFIG_YAML = `
version: 1
allow_paid: true
providers:
  - id: tavily
    enabled: true
    priority: 10
    credentials:
      - name: TAVILY_API_KEY
        required: true
    account: {}
  - id: exa
    enabled: true
    priority: 20
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
export function makeEngine(options = {}) {
    const adapters = options.adapters ?? ADAPTERS;
    const config = mergeDefaultProviders(parseConfig(options.yaml ?? CONFIG_YAML, { lookup: createSchemaLookup(adapters) }), adapters);
    const credentials = loadCredentials({
        env: options.env ?? { TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' },
    });
    const db = SqliteAdapter.open(':memory:', { wal: false }, options.now ?? Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const engine = new Engine({
        db,
        config,
        credentials,
        adapters: new Map(adapters.map((a) => [a.id, a])),
        fetchImpl: options.fetchImpl ?? fakeFetch(options.routes ?? {}),
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    engine.bootstrap();
    return { engine, db, close: () => db.close() };
}
test('a Zhihu-restricted search never returns an unrelated domain', async () => {
    const h = makeEngine({ routes: { 'https://api.tavily.com/search': { status: 200, body: TAVILY_SEARCH_OK } } });
    try {
        const result = await h.engine.search({ query: 'experience', site: 'zhihu' });
        if (result.ok)
            assert.ok(result.data.every((hit) => new URL(hit.url).hostname.endsWith('.zhihu.com') || new URL(hit.url).hostname === 'zhihu.com'));
    }
    finally {
        h.close();
    }
});
test('an explicit 百科 request routes to Baidu without extra flags', async () => {
    const base = ADAPTERS.find((a) => a.id === 'baidu');
    let called = 0;
    const baidu = { ...base, information: async () => { called += 1; return { ok: true, usage: 1, data: { type: 'encyclopedia', source: 'baidu', data: {} } }; } };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: baidu\n', adapters: [baidu], env: { BAIDU_API_KEY: 'a' } });
    try {
        const result = await h.engine.information({ query: '李白的百度百科词条' });
        assert.equal(result.ok, true);
        assert.equal(called, 1);
    }
    finally {
        h.close();
    }
});
test('Baidu encyclopedia calls are observed separately from Baidu search quota', async () => {
    const base = ADAPTERS.find((a) => a.id === 'baidu');
    const baidu = { ...base, information: async () => ({ ok: true, usage: 1, data: { type: 'encyclopedia', source: 'baidu', data: { lemma_title: 'x' } } }) };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: baidu\n', adapters: [baidu], env: { BAIDU_API_KEY: 'a' } });
    try {
        const result = await h.engine.information({ query: '李白', kind: 'encyclopedia' });
        assert.equal(result.ok, true);
        assert.equal(h.db.getProvider('baidu')?.day_used, 0, 'the Baike allowance is not the AI-search daily counter');
        assert.equal(readObserved(h.db, 'baidu', 'encyclopedia')?.count, 1);
    }
    finally {
        h.close();
    }
});
test('Doubao information stays in the shared monthly search quota', async () => {
    const base = ADAPTERS.find((a) => a.id === 'doubao');
    const doubao = { ...base, information: async () => ({ ok: true, usage: 1, data: { type: 'card', source: 'doubao', data: [{}] } }) };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: doubao\n', adapters: [doubao], env: { DOUBAO_SEARCH_API_KEY: 'a' } });
    try {
        await h.engine.information({ query: '北京天气' });
        assert.equal(h.db.getProvider('doubao')?.month_used, 1, 'Global and Custom share the account quota');
    }
    finally {
        h.close();
    }
});
test('Zhihu content fetch is observed separately from Zhihu search quota', async () => {
    const base = ADAPTERS.find((a) => a.id === 'zhihu');
    const zhihu = { ...base, fetch: async () => ({ ok: true, usage: 1, data: { url: 'https://www.zhihu.com/p/1', content: 'text' } }) };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: zhihu\n', adapters: [zhihu], env: { ZHIHU_API_KEY: 'a' } });
    try {
        const result = await h.engine.fetch({ url: 'https://www.zhihu.com/p/1' });
        assert.equal(result.ok, true);
        assert.equal(h.db.getProvider('zhihu')?.day_used, 0, 'content endpoints are metered separately');
        assert.equal(readObserved(h.db, 'zhihu', 'content')?.count, 1);
    }
    finally {
        h.close();
    }
});
test('Zhihu search is preferred and fallback remains site constrained', async () => {
    const calls = [];
    const baseZhihu = ADAPTERS.find((a) => a.id === 'zhihu');
    const baseTavily = ADAPTERS.find((a) => a.id === 'tavily');
    const zhihu = { ...baseZhihu, search: async (_ctx, req) => {
            calls.push({ id: 'zhihu', ...req });
            return { ok: false, classification: { kind: 'transient', evidence: 'unavailable' } };
        } };
    const tavily = { ...baseTavily, search: async (_ctx, req) => {
            calls.push({ id: 'tavily', ...req });
            return { ok: true, usage: 1, data: [
                    { title: 'good', url: 'https://zhuanlan.zhihu.com/p/123' },
                    { title: 'spoof', url: 'https://zhihu.com.evil.example/p/1' },
                    { title: 'outside', url: 'https://example.com/' },
                ] };
        } };
    const yaml = `version: 1\nproviders:\n  - id: tavily\n    priority: 10\n  - id: zhihu\n    priority: 50\n    account:\n      db: global\n`;
    const h = makeEngine({ yaml, adapters: [tavily, zhihu], env: { TAVILY_API_KEY: 'a', ZHIHU_API_KEY: 'b' } });
    try {
        const result = await h.engine.search({ query: '经验', site: 'zhihu' });
        assert.equal(result.ok, true);
        if (result.ok)
            assert.deepEqual(result.data.map((x) => x.title), ['good']);
        assert.deepEqual(calls.map((c) => c.id), ['zhihu', 'tavily']);
        assert.equal(calls[0]?.site, 'zhihu');
        assert.match(calls[1]?.query ?? '', /site:zhihu\.com/);
    }
    finally {
        h.close();
    }
});
test('a Baike URL is offered to Baidu first, then falls back to the ordinary chain', async () => {
    const baseBaidu = ADAPTERS.find((a) => a.id === 'baidu');
    const baseTavily = ADAPTERS.find((a) => a.id === 'tavily');
    const order = [];
    const baidu = { ...baseBaidu, fetch: async () => { order.push('baidu'); return { ok: false, classification: { kind: 'our_problem', evidence: 'no abstract' } }; } };
    const tavily = { ...baseTavily, fetch: async () => { order.push('tavily'); return { ok: true, usage: 1, data: { url: 'https://baike.baidu.com/item/x/1', content: 'page text' } }; } };
    const yaml = 'version: 1\nproviders:\n  - id: tavily\n    priority: 10\n  - id: baidu\n    priority: 90\n';
    const h = makeEngine({ yaml, adapters: [tavily, baidu], env: { TAVILY_API_KEY: 'a', BAIDU_API_KEY: 'b' } });
    try {
        const result = await h.engine.fetch({ url: 'https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/1' });
        assert.equal(result.ok, true);
        assert.deepEqual(order, ['baidu', 'tavily']);
    }
    finally {
        h.close();
    }
    const other = makeEngine({ yaml, adapters: [tavily, baidu], env: { TAVILY_API_KEY: 'a', BAIDU_API_KEY: 'b' } });
    try {
        order.length = 0;
        await other.engine.fetch({ url: 'https://example.com/a' });
        assert.deepEqual(order, ['tavily'], 'an unrelated URL keeps the configured order');
    }
    finally {
        other.close();
    }
});
test('empty Zhihu results count usage and site query continues to fallback', async () => {
    const baseZhihu = ADAPTERS.find((a) => a.id === 'zhihu');
    const baseTavily = ADAPTERS.find((a) => a.id === 'tavily');
    const zhihu = { ...baseZhihu, search: async () => ({ ok: true, usage: 1, data: [] }) };
    const tavily = { ...baseTavily, search: async () => ({ ok: true, usage: 1, data: [
                { title: 'site', url: 'https://www.zhihu.com/question/1' },
            ] }) };
    const yaml = `version: 1\nproviders:\n  - id: tavily\n    priority: 10\n  - id: zhihu\n    priority: 50\n`;
    const h = makeEngine({ yaml, adapters: [tavily, zhihu], env: { TAVILY_API_KEY: 'a', ZHIHU_API_KEY: 'b' } });
    try {
        const result = await h.engine.search({ query: '经验 site:zhihu.com' });
        assert.equal(result.ok, true);
        if (result.ok)
            assert.equal(result.data[0]?.title, 'site');
        assert.equal(h.db.getProvider('zhihu')?.day_used, 1);
        assert.equal(h.db.getProvider('zhihu')?.is_available, 0);
    }
    finally {
        h.close();
    }
});
test('information with no cards counts the call and falls back to labeled web results', async () => {
    const base = ADAPTERS.find((a) => a.id === 'doubao');
    const doubao = { ...base,
        information: async () => ({ ok: true, usage: 1, data: { type: 'card', source: 'doubao', data: [] } }),
        search: async () => ({ ok: true, usage: 1, data: [{ title: 'weather page', url: 'https://example.org/weather' }] }),
    };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: doubao\n', adapters: [doubao], env: { DOUBAO_SEARCH_API_KEY: 'a' } });
    try {
        const result = await h.engine.information({ query: '北京天气' });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.data.type, 'web-fallback');
            assert.deepEqual(result.data.data, [{ title: 'weather page', url: 'https://example.org/weather' }]);
        }
        assert.equal(h.db.getProvider('doubao')?.month_used, 2);
    }
    finally {
        h.close();
    }
});
test('information API rejects conflicting source and kind before provider calls', async () => {
    let calls = 0;
    const base = ADAPTERS.find((a) => a.id === 'doubao');
    const doubao = { ...base, information: async () => { calls += 1; return { ok: true, usage: 1, data: { type: 'card', source: 'doubao', data: [{}] } }; } };
    const h = makeEngine({ yaml: 'version: 1\nproviders:\n  - id: doubao\n', adapters: [doubao], env: { DOUBAO_SEARCH_API_KEY: 'a' } });
    try {
        const result = await h.engine.information({ query: '百科', kind: 'encyclopedia', source: 'doubao' });
        assert.equal(result.ok, false);
        if (!result.ok)
            assert.equal(result.reason, 'config_error');
        assert.equal(calls, 0);
    }
    finally {
        h.close();
    }
});
test('a successful search returns results and counts usage in the actual billing unit', async () => {
    const h = makeEngine({ routes: { 'https://api.tavily.com/search': { status: 200, body: TAVILY_SEARCH_OK } } });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true);
    const row = h.db.getProvider('tavily');
    assert.equal(row?.month_used, 1, 'Tavily basic is 1 credit per call');
    assert.equal(row?.is_available, 0);
    h.close();
});
test('when the first choice fails it automatically switches to the next provider, transparently to the caller', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 503, body: 'busy' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true);
    assert.equal(h.db.getProvider('tavily')?.month_used ?? 0, 0, 'a failed provider must not be charged');
    const tavily = h.db.getProvider('tavily');
    assert.equal((tavily?.is_available ?? 0) & BIT.TRANSIENT, 0, 'cooldown is not a bit (audit §2.1)');
    assert.ok((tavily?.retry_after ?? 0) > 0, 'a cooldown must have an expiry time');
    h.close();
});
test('quota exhaustion sets the bit and switches providers — no consecutive-failure counter is involved', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 402, body: 'payment required' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true);
    const tavily = h.db.getProvider('tavily');
    assert.equal((tavily?.is_available ?? 0) & BIT.QUOTA_MONTH, 0, '402 writes the exhausted-period key, not the bit');
    assert.equal(h.db.readExhaustedKey('tavily', 'month'), monthKey(tavily?.reset_timezone ?? DEFAULT_TIMEZONE, Date.now()), '402 must persist the monthly exhausted-period key');
    assert.equal(tavily?.transient_streak, 0, 'quota exhaustion must not count toward the transient failure streak');
    h.close();
});
test('when every candidate fails transiently, return all_transient with retryable true', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 503, body: 'busy' },
            'https://api.exa.ai/search': { status: 502, body: 'bad gateway' },
        },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.reason, 'all_transient');
        assert.equal(result.retryable, true, 'a transient failure must tell the caller that a retry is possible');
        assert.ok(result.retry_after !== null, 'must give the earliest time a retry can succeed');
        // The merged roster reports every candidate it walked; at least the two keyed ones must show.
        assert.ok(result.providers.length >= 2, 'the report carries all attempted providers');
    }
    h.close();
});
test('when every candidate is out of quota, return no_provider_available with retryable false', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 402, body: 'x' },
            'https://api.exa.ai/search': { status: 402, body: 'x' },
        },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.reason, 'no_provider_available');
        assert.equal(result.retryable, false, 'retrying is useless when the quota is exhausted');
    }
    h.close();
});
test('the failure report gives a reason and "what to do" per provider, and contains no credential values', async () => {
    const h = makeEngine({
        env: { EXA_API_KEY: 'k2' }, // TAVILY_API_KEY is missing
        routes: { 'https://api.exa.ai/search': { status: 402, body: 'x' } },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, false);
    if (!result.ok) {
        const tavily = result.providers.find((p) => p.id === 'tavily');
        assert.ok(tavily);
        assert.deepEqual(tavily.state, ['credential_missing']);
        assert.deepEqual(tavily.missing_env, ['TAVILY_API_KEY'], 'give only the variable name, never the value');
        assert.match(tavily.action_for_llm, /TAVILY_API_KEY/);
        const serialized = JSON.stringify(result);
        assert.ok(!serialized.includes('k1') && !serialized.includes('k2'), 'credential values must never appear in the report');
    }
    h.close();
});
test('a provider with missing credentials is skipped and no request is made', async () => {
    let called = 0;
    const countingFetch = (async () => {
        called += 1;
        return new Response(TAVILY_SEARCH_OK, { status: 200 });
    });
    const adapters = ADAPTERS;
    const config = parseConfig(CONFIG_YAML, { lookup: createSchemaLookup(adapters) });
    const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const engine = new Engine({
        db,
        config,
        credentials: loadCredentials({ env: {} }), // both keys are missing
        adapters: new Map(adapters.map((a) => [a.id, a])),
        fetchImpl: countingFetch,
    });
    engine.bootstrap();
    const result = await engine.search({ query: 'x' });
    assert.equal(result.ok, false);
    assert.equal(called, 0, 'no request may be made while credentials are missing');
    db.close();
});
test('paid gate: prepaid-included consumption passes without acceptance (exa)', async () => {
    const yaml = `
version: 1
allow_paid: false
providers:
  - id: exa
    enabled: true
    priority: 10
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
    const h = makeEngine({
        yaml,
        routes: { 'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK } },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true, 'consumption of a prepaid pool creates no cash-flow event; the gate must not apply');
    const exa = h.db.getProvider('exa');
    assert.equal((exa?.is_available ?? 0) & BIT.PAID_NOT_ALLOWED, 0);
    h.close();
});
test('candidacy is restored automatically once the cooldown expires, with no timer required', async () => {
    const clock = { now: Date.UTC(2026, 9, 29, 12) };
    const h = makeEngine({
        now: () => clock.now,
        routes: {
            'https://api.tavily.com/search': { status: 503, body: 'busy' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        },
    });
    await h.engine.search({ query: 'x' });
    assert.ok((h.db.getProvider('tavily')?.retry_after ?? 0) > 0, 'the failure persists as a future retry_after');
    // cooldown not yet expired: still unusable
    clock.now += 100;
    h.engine.status();
    assert.ok((h.db.getProvider('tavily')?.retry_after ?? 0) > clock.now, 'the cooldown has not expired, so it should not recover');
    // past the 60s cap: the next status() call resets it lazily, no timer involved
    clock.now += 61_000;
    h.engine.status();
    assert.equal(h.db.getProvider('tavily')?.retry_after, null, 'an expired cooldown must recover automatically (audit §2.1)');
    h.close();
});
test('backoff grows with consecutive failures and resets to zero on success', async () => {
    const clock = { now: Date.UTC(2026, 9, 29, 12) };
    let fail = true;
    const routes = () => fail
        ? {
            'https://api.tavily.com/search': { status: 503, body: 'x' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        }
        : { 'https://api.tavily.com/search': { status: 200, body: TAVILY_SEARCH_OK } };
    const h = makeEngine({ now: () => clock.now, routes: routes() });
    // first failure
    await h.engine.search({ query: 'x' });
    const first = h.db.getProvider('tavily');
    assert.equal(first?.transient_streak, 1);
    const firstCooldown = (first?.retry_after ?? 0) - clock.now;
    assert.equal(firstCooldown, 1_000, 'the first backoff is 1s');
    // fail again after the cooldown expires
    clock.now += 61_000;
    await h.engine.search({ query: 'x' });
    const second = h.db.getProvider('tavily');
    assert.equal(second?.transient_streak, 2);
    assert.equal((second?.retry_after ?? 0) - clock.now, 2_000, 'the second backoff is 2s');
    h.close();
});
test('a provider disabled via is_enable does not enter the candidate set', async () => {
    const yaml = `
version: 1
allow_paid: true
providers:
  - id: tavily
    enabled: false
    priority: 10
    credentials:
      - name: TAVILY_API_KEY
        required: true
    account: {}
  - id: exa
    enabled: true
    priority: 20
    credentials:
      - name: EXA_API_KEY
        required: true
    account: {}
`;
    const h = makeEngine({
        yaml,
        routes: { 'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK } },
    });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true);
    h.close();
});
test('the --problems filter on status returns only the problematic entries', () => {
    const h = makeEngine({
        env: { EXA_API_KEY: 'k2' },
        routes: {},
    });
    const all = h.engine.status(false);
    const problems = h.engine.status(true);
    // The merged roster lists all providers; the keyed subset is what this fixture can use.
    const keyed = all.filter((p) => p.id === 'tavily' || p.id === 'exa');
    assert.equal(keyed.length, 2);
    assert.equal(keyed.filter((p) => p.usable).length, 1, 'exa is usable with its key, tavily is not');
    assert.equal((problems.find((p) => p.id === 'tavily') !== undefined), true, 'tavily is a problem');
    assert.equal((problems.find((p) => p.id === 'exa') === undefined), true, 'exa stays out of --problems');
    assert.ok(problems.every((p) => !p.usable), 'problems lists only problematic entries');
    h.close();
});
test('re-seeding: a change in the account tier summary also triggers it (not just the version number)', () => {
    const yaml = (developer) => `
version: 1
allow_paid: true
providers:
  - id: anysearch
    enabled: true
    priority: 1
    credentials:
      - name: ANYSEARCH_API_KEY
        required: true
    account:
      developer: ${developer}
`;
    // a minimal adapter, to isolate the re-seed trigger condition
    const adapter = {
        id: 'anysearch',
        capabilities: ['search'],
        schema: {
            id: 'anysearch',
            requiresCredentials: true,
            credentialNames: ['ANYSEARCH_API_KEY'],
            accountOptions: {
                developer: { type: 'boolean', description: 'account tier', default: false },
            },
        },
        init: (account) => ({
            version: 1,
            canCharge: false,
            quotaPeriod: 'day',
            dayLimit: account['developer'] === true ? 2000 : 1000,
            monthLimit: null,
            unit: 'requests',
            resetTimezone: 'UTC',
        }),
    };
    const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const build = (developer) => {
        const config = parseConfig(yaml(developer), { lookup: createSchemaLookup([adapter]) });
        return new Engine({
            db,
            config,
            credentials: loadCredentials({ env: { ANYSEARCH_API_KEY: 'k' } }),
            adapters: new Map([[adapter.id, adapter]]),
            fetchImpl: fakeFetch({}),
        });
    };
    build(false).bootstrap();
    assert.equal(db.getProvider('anysearch')?.day_limit, 1000);
    // the version number is unchanged — only the account tier changed
    build(true).bootstrap();
    assert.equal(db.getProvider('anysearch')?.day_limit, 2000, 'a tier change must trigger a re-seed');
    db.addUsed('anysearch', 'day', 7);
    build(false).bootstrap();
    assert.equal(db.getProvider('anysearch')?.day_limit, 1000);
    assert.equal(db.getProvider('anysearch')?.day_used, 7, 're-seeding must never touch the usage counters');
    db.close();
});
test('rejection_count counts refusals (quota, rate limit, rejected credential) but not transient faults', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 402, body: 'payment required' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        },
    });
    await h.engine.search({ query: 'x' });
    const tavily = h.engine.status(false).find((p) => p.id === 'tavily');
    assert.equal(tavily?.rejection_count, 1, 'a quota refusal is one rejected request');
    h.close();
});
test('a transient network fault is not a rejection: the provider did not refuse the request', async () => {
    const h = makeEngine({
        routes: {
            'https://api.tavily.com/search': { status: 503, body: 'busy' },
            'https://api.exa.ai/search': { status: 200, body: EXA_SEARCH_OK },
        },
    });
    await h.engine.search({ query: 'x' });
    const tavily = h.engine.status(false).find((p) => p.id === 'tavily');
    assert.equal(tavily?.rejection_count, 0, 'a 5xx is our problem to retry, not a refusal');
    h.close();
});
test('the success payload is exactly {ok, data}: provider selection stays internal', async () => {
    const h = makeEngine({ routes: { 'https://api.tavily.com/search': { status: 200, body: TAVILY_SEARCH_OK } } });
    const result = await h.engine.search({ query: 'x' });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ['data', 'ok'], 'no provider, no capability, no quota');
    h.close();
});
test('the status payload exposes the documented snake_case fields and nothing else', () => {
    const h = makeEngine({ routes: {} });
    const [report] = h.engine.status(false);
    assert.deepEqual(Object.keys(report ?? {}).sort(), ['action_for_llm', 'enabled', 'id', 'missing_env', 'needs_migration', 'period', 'rejection_count', 'resets_at', 'state', 'usable'], 'the external contract is snake_case and additive changes must update this list deliberately');
    h.close();
});
test('booting without credentials never bricks the provider: keys appearing later are not a pool change', async () => {
    // Two engines share one database; the first starts with no credentials at all.
    const config = parseConfig(CONFIG_YAML, { lookup: createSchemaLookup(ADAPTERS) });
    const db = SqliteAdapter.open(':memory:', { wal: false }, Date.now);
    applySchema(db, DDL);
    writeSchemaVersion(db);
    const routes = { 'https://api.tavily.com/search': { status: 200, body: TAVILY_SEARCH_OK } };
    const mk = (env) => new Engine({
        db,
        config,
        credentials: loadCredentials({ env }),
        adapters: new Map(ADAPTERS.map((a) => [a.id, a])),
        fetchImpl: fakeFetch(routes),
    });
    const first = mk({});
    await first.search({ query: 'x' });
    const second = mk({ TAVILY_API_KEY: 'k1', EXA_API_KEY: 'k2' });
    second.bootstrap();
    await second.search({ query: 'x' });
    const row = db.getProvider('tavily');
    assert.equal(row?.needs_migration, 0, 'missing→present credentials is not a billing-pool change');
    assert.ok((row?.month_used ?? 0) > 0, 'the request is served by tavily');
    db.close();
});
//# sourceMappingURL=engine.test.js.map