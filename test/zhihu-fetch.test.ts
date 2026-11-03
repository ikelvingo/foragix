import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zhihuAdapter } from '../src/providers/zhihu/index.js';
import type { AdapterContext } from '../src/providers/types.js';

function context(calls: string[], payload: unknown): AdapterContext {
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return {
    credentials: { get: () => 'fake-key', has: () => true, fingerprint: () => 'fake', describe: () => [] },
    config: { id: 'zhihu', enabled: true, priority: 1, credentials: [], account: {}, allowPaid: null },
    fetchImpl, now: () => 1700000000000, credentialNames: [],
  };
}

test('Zhihu fetch asks the creator-detail endpoint with the canonical ContentUrl', async () => {
  assert.ok(zhihuAdapter.capabilities.includes('fetch'));
  const calls: string[] = [];
  const target = 'https://www.zhihu.com/question/1/answer/2';
  const out = await zhihuAdapter.fetch!(context(calls, { Code: 0, Data: { Url: target, Title: '标题', Body: '<p>第一段</p><p>第二段</p>' } }), { url: `${target}?utm=1` });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.data.url, `${target}?utm=1`, 'the caller-provided URL is echoed');
    assert.equal(out.data.title, '标题');
    assert.match(out.data.content, /第一段/);
    assert.ok(!out.data.content.includes('<p>'));
  }
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, '/api/v1/user/content_detail');
  assert.equal(url.searchParams.get('ContentUrl'), target);
});

test('Zhihu fetch refuses content that is not the requested one', async () => {
  const out = await zhihuAdapter.fetch!(context([], { Code: 0, Data: { Url: 'https://www.zhihu.com/question/1/answer/999', Body: '<p>x</p>' } }), { url: 'https://www.zhihu.com/question/1/answer/2' });
  assert.equal(out.ok, false);
});

test('Zhihu fetch reports non-owner or invalid content as a failure so the chain falls back', async () => {
  const out = await zhihuAdapter.fetch!(context([], { Code: 10001, Message: 'invalid parameter' }), { url: 'https://www.zhihu.com/question/1/answer/2' });
  assert.equal(out.ok, false);
});

test('Zhihu fetch refuses a response without a body instead of returning empty text', async () => {
  const target = 'https://zhuanlan.zhihu.com/p/9';
  const out = await zhihuAdapter.fetch!(context([], { Code: 0, Data: { Url: target } }), { url: target });
  assert.equal(out.ok, false);
});

test('Zhihu fetch ignores non-content Zhihu URLs', async () => {
  const out = await zhihuAdapter.fetch!(context([], { Code: 0 }), { url: 'https://www.zhihu.com/people/x' });
  assert.equal(out.ok, false);
});
