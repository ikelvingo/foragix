/**
 * Adapter-level tests for the baidu and zhipu adapters: request shape and response mapping
 * against mocked fetch. The harness and pins stay provider-specific only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, AdapterOutcome, FetchDocument, ProviderAdapter, SearchHit } from '../src/providers/types.js';
import { baiduAdapter } from '../src/providers/baidu/index.js';
import { zhipuAdapter } from '../src/providers/zhipu/index.js';
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
// Baidu
// ---------------------------------------------------------------------------

test('baidu search POSTs the verified messages body to the qianfan gateway', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { request_id: 'r1', references: [{ id: 1, url: 'https://b', title: 'T', content: 'C', date: '2026-10-29' }] } },
  ]);
  const outcome = await runCapability(baiduAdapter, 'search', ctx, { query: 'q', maxResults: 55 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://b', snippet: 'C' }]);
    assert.equal(outcome.usage, 1);
  }
  assert.equal(calls[0]!.url, 'https://qianfan.baidubce.com/v2/ai_search');
  assert.equal(calls[0]!.headers.authorization, 'Bearer fake-value-for-BAIDU_API_KEY');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { messages: [{ role: 'user', content: 'q' }] });
});

test('baidu refuses loudly on an unrecognized 200 shape instead of failing silently', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 200, body: { unknown_key: [] } }]);
  const outcome = await runCapability(baiduAdapter, 'search', ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.classification.kind, 'our_problem');
});

test('baidu envelope error carrying quota semantics is daily quota exhaustion', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { error_code: 5009, error_msg: 'daily free quota exhausted' } },
  ]);
  const outcome = await runCapability(baiduAdapter, 'search', ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'quota');
    assert.equal(outcome.classification.period, 'day');
  }
});

test('baidu envelope error without quota semantics stays our_problem, provider text redacted', async () => {
  const secret = 'Bearer MastSecretToken123/abc';
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { error_code: 17, error_msg: `internal error key=${secret}` } },
  ]);
  const outcome = await runCapability(baiduAdapter, 'search', ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'our_problem');
    assert.match(outcome.classification.evidence, /^baidu error envelope code=17 \(/);
    assert.ok(!outcome.classification.evidence.includes(secret), 'provider message must not pass through unredacted');
  }
});

test('baidu daily free quota is 100 calls, Beijing-time reset, paid-gated', () => {
  const init = baiduAdapter.init({});
  assert.equal(init.canCharge, true);
  assert.equal(init.quotaPeriod, 'day');
  assert.equal(init.dayLimit, 100);
  assert.equal(init.resetTimezone, 'Asia/Shanghai');
  assert.deepEqual(baiduAdapter.capabilities, ['search']);
});

// ---------------------------------------------------------------------------
// Zhipu
// ---------------------------------------------------------------------------

test('zhipu search truncates the query to 70 chars and pins the base engine', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { search_result: [{ title: 'T', content: 'C', link: 'https://z' }] } },
  ]);
  const outcome = await runCapability(zhipuAdapter, 'search', ctx, { query: 'x'.repeat(99), maxResults: 3 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://z', snippet: 'C' }]);
  }
  assert.equal(calls[0]!.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  const body = JSON.parse(calls[0]!.body ?? '{}');
  assert.equal(body.search_engine, 'search_std');
  assert.equal(body.search_intent, false);
  assert.equal(body.search_query.length, 70);
  assert.equal(body.count, 3);
});

test('zhipu fetch maps the reader_result document', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { reader_result: { content: 'md text', title: 'TT', url: 'https://rr' } } },
  ]);
  const outcome = await runCapability(zhipuAdapter, 'fetch', ctx, { url: 'https://original' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const doc = outcome.data as FetchDocument;
    assert.deepEqual(doc, { url: 'https://rr', title: 'TT', content: 'md text' });
  }
  assert.equal(calls[0]!.url, 'https://open.bigmodel.cn/api/paas/v4/reader');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { url: 'https://original' });
});

test('zhipu verified error codes: auth and in-band quota cap', async () => {
  assert.deepEqual(zhipuAdapter.errorHints?.authErrorCodes, ['1000', '1001', '1003', '1005']);
  assert.deepEqual(zhipuAdapter.errorHints?.quotaErrorCodes, ['1308', '1113']);
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 401, body: { code: 1001, message: 'auth missing' } }]);
  const outcome = await runCapability(zhipuAdapter, 'search', ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.classification.kind, 'credential_rejected');
});

test('zhipu billing semantics: paid-gated, no locally resettable period', () => {
  const init = zhipuAdapter.init({});
  assert.equal(init.canCharge, true);
  assert.equal(init.quotaPeriod, 'none');
  assert.deepEqual(zhipuAdapter.capabilities, ['search', 'fetch']);
});
