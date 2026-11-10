import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, ProviderAdapter } from '../src/providers/types.js';
import { ADAPTERS, getAdapter, adapterIds } from '../src/providers/registry.js';
import { buildDefaultConfig } from '../src/config/defaults.js';
import type { CredentialPresence } from '../src/credentials/load.js';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface MockResponseSpec {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const CREDENTIALS: AdapterContext['credentials'] = {
  has: () => true,
  get: () => 'fake-parallel-key',
  fingerprint: () => 'fake-fingerprint',
  describe: (names: readonly string[]) =>
    names.map((name) => ({ name, present: true })) as unknown as CredentialPresence[],
};

function makeContext(calls: CapturedCall[], responses: MockResponseSpec[]): AdapterContext {
  let index = 0;
  const fetchImpl: typeof globalThis.fetch = async (rawUrl: unknown, init?: RequestInit) => {
    const spec = responses[index];
    if (spec === undefined) throw new Error(`no mock response for call #${index}`);
    index += 1;
    const headers: Record<string, string> = {};
    new Map(Object.entries(init?.headers ?? {})).forEach((value, key) => {
      headers[key.toLowerCase()] = String(value);
    });
    calls.push({
      url: String(rawUrl),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const entries = Object.entries(spec.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value] as const);
    const responseHeaders = {
      forEach: (cb: (value: string, key: string) => void) => entries.forEach(([key, value]) => cb(value, key)),
    };
    const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return { status: spec.status, headers: responseHeaders, text: async () => body } as unknown as Response;
  };
  return {
    credentials: CREDENTIALS,
    config: {
      id: 'parallel',
      enabled: true,
      priority: 100,
      credentials: [{ name: 'PARALLEL_API_KEY', required: true }],
      account: {},
      allowPaid: null,
    },
    fetchImpl,
    now: () => 1_700_000_000_000,
    credentialNames: ['PARALLEL_API_KEY'],
  };
}

function adapter(): ProviderAdapter {
  const found = getAdapter('parallel');
  assert.ok(found, 'parallel must be registered');
  return found;
}

test('parallel is registered with search and fetch, a monthly $5 ceiling, and no local cap', () => {
  const provider = adapter();
  assert.deepEqual(provider.capabilities, ['search', 'fetch']);
  assert.deepEqual(provider.schema.credentialNames, ['PARALLEL_API_KEY']);
  assert.equal(provider.schema.localCap, undefined, 'only brave may declare a local cap');
  const init = provider.init({});
  assert.equal(init.quotaPeriod, 'month');
  assert.equal(init.monthLimit, 5_000);
  assert.equal(init.dayLimit, null);
  assert.equal(init.canCharge, true);

  const ids = adapterIds();
  const priorities = new Map(buildDefaultConfig(ADAPTERS).providers.map((item) => [item.id, item.priority]));
  assert.equal(ids.indexOf('parallel'), ids.indexOf('ollama') + 1);
  assert.ok((priorities.get('ollama') ?? Number.POSITIVE_INFINITY) < (priorities.get('parallel') ?? -1));
  assert.ok((priorities.get('parallel') ?? Number.POSITIVE_INFINITY) < (priorities.get('linkup') ?? -1));
});

test('parallel search uses the cheap fast mode and maps titles, urls, and joined excerpts', async () => {
  const calls: CapturedCall[] = [];
  const provider = adapter();
  assert.ok(provider.search);
  const outcome = await provider.search(makeContext(calls, [{
    status: 200,
    body: {
      search_id: 'search_1',
      results: [
        { url: 'https://example.com/a', title: 'A', excerpts: ['first', '', 'second'] },
        { url: 'https://example.com/b', title: null, excerpts: [] },
      ],
      usage: [{ name: 'sku_search', count: 1 }],
      session_id: 'session_1',
    },
  }]), { query: 'typescript practices', maxResults: 3 });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [
      { title: 'A', url: 'https://example.com/a', snippet: 'first\n\nsecond' },
      { title: 'https://example.com/b', url: 'https://example.com/b' },
    ]);
    assert.equal(outcome.usage, 1);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.parallel.ai/v1/search');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['x-api-key'], 'fake-parallel-key');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    objective: 'typescript practices',
    search_queries: ['typescript practices'],
    mode: 'fast',
    advanced_settings: { max_results: 3 },
  });
});

test('parallel search omits advanced settings when the caller gives no count', async () => {
  const calls: CapturedCall[] = [];
  const provider = adapter();
  assert.ok(provider.search);
  const outcome = await provider.search(makeContext(calls, [{
    status: 200,
    body: { search_id: 's', results: [], session_id: 'session' },
  }]), { query: 'q' });
  assert.equal(outcome.ok, true);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    objective: 'q',
    search_queries: ['q'],
    mode: 'fast',
  });
});

test('parallel search turns --site zhihu into a native domain filter', async () => {
  const calls: CapturedCall[] = [];
  const provider = adapter();
  assert.ok(provider.search);
  const outcome = await provider.search(makeContext(calls, [{
    status: 200,
    body: { search_id: 's', results: [], session_id: 'session' },
  }]), { query: '经验 site:zhihu.com', site: 'zhihu', maxResults: 5 });
  assert.equal(outcome.ok, true);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    objective: '经验',
    search_queries: ['经验'],
    mode: 'fast',
    advanced_settings: { max_results: 5, source_policy: { include_domains: ['zhihu.com'] } },
  });
});

test('parallel maps 402 to monthly quota and 429 to a short-window cooldown', async () => {
  const provider = adapter();
  assert.ok(provider.search);

  const quota = await provider.search(makeContext([], [{
    status: 402,
    body: { type: 'error', error: { message: 'Payment required: insufficient credit in account' } },
  }]), { query: 'q' });
  assert.equal(quota.ok, false);
  if (!quota.ok) {
    assert.equal(quota.classification.kind, 'quota');
    if (quota.classification.kind === 'quota') assert.equal(quota.classification.period, 'month');
  }

  const limited = await provider.search(makeContext([], [{
    status: 429,
    headers: { 'Retry-After': '2' },
    body: { type: 'error', error: { message: 'Too many requests: quota temporarily exceeded' } },
  }]), { query: 'q' });
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.classification.kind, 'rate_limited_short');
    if (limited.classification.kind === 'rate_limited_short') assert.equal(limited.classification.cooldownMs, 2_000);
  }
});

test('parallel fetch requests full content and prefers full_content over excerpts', async () => {
  const calls: CapturedCall[] = [];
  const provider = adapter();
  assert.ok(provider.fetch);
  const pageUrl = 'https://example.com/page?a=1&b=two';
  const outcome = await provider.fetch(makeContext(calls, [{
    status: 200,
    body: {
      extract_id: 'extract_1',
      results: [{ url: pageUrl, title: 'Example', excerpts: ['short'], full_content: '# Full markdown' }],
      errors: [],
      session_id: 'session_1',
    },
  }]), { url: pageUrl });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, { url: pageUrl, title: 'Example', content: '# Full markdown' });
    assert.equal(outcome.usage, 1);
  }
  assert.equal(calls[0]!.url, 'https://api.parallel.ai/v1/extract');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    urls: [pageUrl],
    advanced_settings: { full_content: true },
  });
});

test('parallel fetch falls back to excerpts and reports an upstream page failure as our problem', async () => {
  const provider = adapter();
  assert.ok(provider.fetch);

  const excerpts = await provider.fetch(makeContext([], [{
    status: 200,
    body: {
      extract_id: 'e',
      results: [{ url: 'https://example.com', title: null, excerpts: ['one', 'two'], full_content: null }],
      errors: [],
      session_id: 's',
    },
  }]), { url: 'https://example.com' });
  assert.equal(excerpts.ok, true);
  if (excerpts.ok) assert.equal(excerpts.data.content, 'one\n\ntwo');

  const failed = await provider.fetch(makeContext([], [{
    status: 200,
    body: {
      extract_id: 'e',
      results: [],
      errors: [{ url: 'https://example.com', error_type: 'fetch_error', http_status_code: 500, content: 'boom' }],
      session_id: 's',
    },
  }]), { url: 'https://example.com' });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.classification.kind, 'our_problem');
});
