/**
 * Adapter-level tests for the you.com and tinyfish adapters: request shape and response
 * mapping against mocked fetch. Pins stay provider-specific only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, SearchHit } from '../src/providers/types.js';
import { youAdapter } from '../src/providers/you/index.js';
import { tinyfishAdapter } from '../src/providers/tinyfish/index.js';
import type { CredentialPresence } from '../src/credentials/load.js';

const CREDENTIALS: AdapterContext['credentials'] = {
  has: () => true,
  get: (name: string) => `fake-value-for-${name}`,
  fingerprint: () => 'fake-fingerprint',
  describe: (names: readonly string[]) =>
    names.map((n) => ({ name: n, present: true })) as unknown as CredentialPresence[],
};

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

function lowercaseHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key.toLowerCase()] = value;
  return out;
}

function makeResponse(spec: MockResponseSpec): Response {
  const entries = Object.entries(lowercaseHeaders(spec.headers ?? {}));
  const headerViews = {
    forEach: (cb: (value: string, key: string) => void) => {
      for (const [key, value] of entries) cb(value, key);
    },
  };
  const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return { status: spec.status, headers: headerViews, text: async () => body } as unknown as Response;
}

function makeContext(
  calls: CapturedCall[],
  responses: MockResponseSpec[],
  account: AdapterContext['config']['account'] = {},
): AdapterContext {
  let index = 0;
  const fetchImpl: typeof globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const spec = responses[index];
    if (spec === undefined) throw new Error(`no mock response for call #${index}`);
    index += 1;
    const reqHeaders: Record<string, string> = {};
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

function runCapability(
  adapter: ProviderAdapter,
  cap: 'search' | 'fetch',
  ctx: AdapterContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
): Promise<AdapterOutcome<SearchHit[] | FetchDocument>> {
  const method = cap === 'search' ? adapter.search : adapter.fetch;
  assert.ok(method !== undefined, `adapter must implement ${cap}`);
  return method.bind(adapter)(ctx, req) as Promise<AdapterOutcome<SearchHit[] | FetchDocument>>;
}

// ---------------------------------------------------------------------------
// You.com
// ---------------------------------------------------------------------------

test('you search POSTs to ydc-index.io/v1/search with X-API-Key and count', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { results: { web: [{ title: 'T', url: 'https://y', description: 'D' }], knowledge: [] } } },
  ]);
  const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q', maxResults: 5 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://y', snippet: 'D' }]);
    assert.equal(outcome.usage, 1);
  }
  assert.equal(calls[0]!.url, 'https://ydc-index.io/v1/search');
  assert.equal(calls[0]!.headers['x-api-key'], 'fake-value-for-YDC_API_KEY');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { query: 'q', count: 5 });
});

test('you search falls back to the first snippet when description is absent', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { results: { web: [{ title: '', url: 'https://y2', snippets: ['s0', 's1'] }] } } },
  ]);
  const outcome = await runCapability(youAdapter, 'search', ctx, { query: 'q' });
  if (outcome.ok) assert.deepEqual(outcome.data, [{ title: '', url: 'https://y2', snippet: 's0' }]);
});

test('you fetch accepts the contents array and prefers markdown', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: [{ url: 'https://x', title: 'P', html: '<p>x</p>', markdown: '# p' }] },
  ]);
  const outcome = await runCapability(youAdapter, 'fetch', ctx, { url: 'https://x' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const doc = outcome.data as FetchDocument;
    assert.deepEqual(doc, { url: 'https://x', title: 'P', content: '# p' });
  }
  assert.equal(calls[0]!.url, 'https://ydc-index.io/v1/contents');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { urls: ['https://x'], formats: ['markdown'] });
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
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { query: 'q', results: [{ title: 'T', url: 'https://tf', snippet: 'S' }], total_results: 10, page: 0 } },
  ]);
  const outcome = await runCapability(tinyfishAdapter, 'search', ctx, { query: 'q', maxResults: 20 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://tf', snippet: 'S' }]);
  }
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(new URL(calls[0]!.url).origin, 'https://api.search.tinyfish.ai');
  assert.equal(new URL(calls[0]!.url).searchParams.get('query'), 'q');
  assert.equal(calls[0]!.headers['x-api-key'], 'fake-value-for-TINYFISH_API_KEY');
});

test('tinyfish fetch carries per-URL failures inside a 200 body', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { results: [], errors: [{ url: 'https://f', error: 'target_http_error', status: 500 }] } },
  ]);
  const outcome = await runCapability(tinyfishAdapter, 'fetch', ctx, { url: 'https://f' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'our_problem');
    assert.match(outcome.classification.evidence, /target_http_error/);
  }
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { urls: ['https://f'], format: 'markdown' });
});

test('tinyfish fetch maps the successful document', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { results: [{ url: 'https://r', title: 'TT', text: '# body' }] } },
  ]);
  const outcome = await runCapability(tinyfishAdapter, 'fetch', ctx, { url: 'https://r' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const doc = outcome.data as FetchDocument;
    assert.deepEqual(doc, { url: 'https://r', title: 'TT', content: '# body' });
  }
});

test('tinyfish quota semantics: paid-gated daily allowances, not locally countable', () => {
  const init = tinyfishAdapter.init({});
  assert.equal(init.canCharge, true);
  assert.equal(init.quotaPeriod, 'day');
  assert.equal(init.dayLimit, null, 'per-capability allowances cannot share one provider-level dayLimit');
  assert.deepEqual(tinyfishAdapter.capabilities, ['search', 'fetch']);
});
