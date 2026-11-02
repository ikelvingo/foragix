/**
 * Adapter-level tests for the brave and minimax adapters: request shape and response mapping
 * against mocked fetch. Engine-level behaviour (routing, bit lifecycle) is covered by their own
 * suites; here we pin only what is provider-specific knowledge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, AdapterOutcome, ProviderAdapter, SearchHit } from '../src/providers/types.js';
import { braveAdapter } from '../src/providers/brave/index.js';
import { minimaxCnAdapter } from '../src/providers/minimax/index.js';
const minimaxAdapter = minimaxCnAdapter;
import type { CredentialPresence } from '../src/credentials/load.js';
import type { ProviderErrorHints } from '../src/errors/classify.js';

/** A credential view that always resolves to a fake value: values never reach any assertion. */
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

/** Builds an adapter context whose `fetchImpl` records every call and replays canned responses. */
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
    config: {
      id: 'test',
      enabled: true,
      priority: 10,
      credentials: [],
      account,
      allowPaid: null,
    },
    fetchImpl,
    now: () => 1_700_000_000_000,
    credentialNames: [],
  };
}

/**
 * Builds a duck-typed Response (status/headers/text are what request() and classify() consume).
 * The global Response/Headers constructors are not used, so the test depends on no DOM typings.
 */
function makeResponse(spec: MockResponseSpec): Response {
  const entries = Object.entries(lowercaseHeaders(spec.headers ?? {}));
  const headerViews = {
    forEach: (cb: (value: string, key: string) => void) => {
      for (const [key, value] of entries) cb(value, key);
    },
  };
  const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return {
    status: spec.status,
    headers: headerViews,
    text: async () => body,
  } as unknown as Response;
}

/** Minimal lowercasing header view for assertions. */
function lowercaseHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key.toLowerCase()] = value;
  return out;
}

/** Calls an adapter's optional `search`, asserting it exists for this adapter. */
async function runSearch(
  adapter: ProviderAdapter,
  ctx: AdapterContext,
  req: { query: string; maxResults?: number },
): Promise<AdapterOutcome<SearchHit[]>> {
  assert.ok(adapter.search !== undefined, 'adapter must implement search');
  const search = adapter.search.bind(adapter);
  return (await search(ctx, req)) as AdapterOutcome<SearchHit[]>;
}

// ---------------------------------------------------------------------------
// MiniMax
// ---------------------------------------------------------------------------

const MINIMAX_OK = { organic: [{ title: 't1', link: 'https://a', snippet: 's1' }] };
const MINIMAX_ENVELOPE_OK = { ...MINIMAX_OK, base_resp: { status_code: 0, status_msg: 'success' } };

test('minimax search sends q to the coding plan endpoint with bearer auth', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 200, body: MINIMAX_ENVELOPE_OK }]);
  const outcome = await runSearch(minimaxAdapter, ctx, { query: 'hello world' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 't1', url: 'https://a', snippet: 's1' }]);
    assert.equal(outcome.usage, 1);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.minimax.cn/v1/coding_plan/search');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers.authorization, 'Bearer fake-value-for-MINIMAX_API_KEY');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { q: 'hello world' });
});

test('minimax ignores maxResults — the endpoint has no pagination', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 200, body: MINIMAX_OK }]);
  await runSearch(minimaxAdapter, ctx, { query: 'q', maxResults: 5 });
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { q: 'q' });
});

test('minimax declares the search capability only', () => {
  assert.deepEqual(minimaxAdapter.capabilities, ['search']);
  assert.equal(minimaxAdapter.schema.credentialNames[0], 'MINIMAX_API_KEY', 'the CN twin keeps the owner key name');
  assert.equal(minimaxAdapter.fetch, undefined);
});

test('minimax init: paid-gated, quotaPeriod none, no countable limits', () => {
  const init = minimaxAdapter.init({});
  assert.equal(init.canCharge, true);
  assert.equal(init.quotaPeriod, 'none');
  assert.equal(init.dayLimit, null);
  assert.equal(init.monthLimit, null);
});

test('minimax HTTP-200 envelope quota code 1028 classifies as quota (unknown period)', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { base_resp: { status_code: 1028, status_msg: 'quota exhausted' } } },
  ]);
  const outcome: AdapterOutcome<SearchHit[]> = await runSearch(minimaxAdapter, ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'quota');
    assert.equal(outcome.classification.period, null);
  }
});

test('minimax envelope moderation code produces our_problem without flags', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    { status: 200, body: { base_resp: { status_code: 1027, status_msg: 'output withheld' } } },
  ]);
  const outcome = await runSearch(minimaxAdapter, ctx, { query: 'q' });
  if (!outcome.ok) assert.equal(outcome.classification.kind, 'our_problem');
});

test('minimax base_url account option overrides the default host', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 200, body: MINIMAX_OK }], {
    base_url: 'https://api.minimax.cn',
  });
  await runSearch(minimaxAdapter, ctx, { query: 'q' });
  assert.equal(calls[0]!.url, 'https://api.minimax.cn/v1/coding_plan/search');
});

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

const BRAVE_OK = { web: { results: [{ title: 'T', url: 'https://x', description: 'D' }] } };

test('brave search GETs the web search endpoint with the subscription token', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [{ status: 200, body: BRAVE_OK }]);
  const outcome = await runSearch(braveAdapter, ctx, { query: 'brave test' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.data, [{ title: 'T', url: 'https://x', snippet: 'D' }]);
  }
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.headers['x-subscription-token'], 'fake-value-for-BRAVE_API_KEY');
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'brave test');
  assert.equal(url.searchParams.get('count'), null, 'no default count sent — the API poller knows its own default');
});

test('brave maps maxResults onto count within the 1..20 range', async () => {
  for (const [requested, expected] of [
    [5, '5'],
    [99, '20'],
    [0, '1'],
  ] as const) {
    const calls: CapturedCall[] = [];
    const ctx = makeContext(calls, [{ status: 200, body: BRAVE_OK }]);
    await runSearch(braveAdapter, ctx, { query: 'q', maxResults: requested });
    assert.equal(new URL(calls[0]!.url).searchParams.get('count'), expected);
  }
});

test('brave monthly-remaining 0 on 429 is monthly quota, not a cooldown', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    {
      status: 429,
      body: {},
      headers: { 'x-ratelimit-remaining': '0, 0', 'x-ratelimit-reset': '1, 1419704' },
    },
  ]);
  const outcome = await runSearch(braveAdapter, ctx, { query: 'q' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'quota');
    assert.equal(outcome.classification.period, 'month');
  }
});

test('brave 429 with a non-zero monthly remaining stays a short-window rate limit', async () => {
  const calls: CapturedCall[] = [];
  const ctx = makeContext(calls, [
    {
      status: 429,
      body: {},
      headers: { 'x-ratelimit-remaining': '0, 1042', 'x-ratelimit-reset': '1, 1419704' },
    },
  ]);
  const outcome = await runSearch(braveAdapter, ctx, { query: 'q' });
  if (!outcome.ok) {
    assert.equal(outcome.classification.kind, 'rate_limited_short');
  }
});

test('brave declares the search capability only and gates paid usage', () => {
  assert.deepEqual(braveAdapter.capabilities, ['search']);
  assert.equal(braveAdapter.fetch, undefined);
  const init = braveAdapter.init({});
  assert.equal(init.canCharge, true);
  assert.equal(init.quotaPeriod, 'month');
  assert.equal(init.monthLimit, 1_000);
});

/** Guard: the generic hints contract must not be silently violated (typed through the adapter). */
test('adapter error hints stay shape-compatible', () => {
  const hints: ProviderErrorHints | undefined = minimaxAdapter.errorHints;
  assert.ok(hints !== undefined);
  assert.deepEqual(hints.quotaErrorCodes, ['1028', '1030']);
});
