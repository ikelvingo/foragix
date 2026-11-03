import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baiduAdapter } from '../src/providers/baidu/index.js';
function context(calls, payloads) {
    let index = 0;
    const fetchImpl = (async (input) => {
        calls.push(String(input));
        const payload = payloads[index] ?? payloads[payloads.length - 1];
        index += 1;
        return new Response(JSON.stringify(payload ?? {}), { status: 200 });
    });
    return {
        credentials: { get: () => 'fake-key', has: () => true, fingerprint: () => 'fake', describe: () => [] },
        config: { id: 'baidu', enabled: true, priority: 1, credentials: [], account: {}, allowPaid: null },
        fetchImpl, now: () => 1700000000000, credentialNames: [],
    };
}
const LEMMA = { lemma_id: 123, lemma_title: '李白', url: 'https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/123', summary: '唐代诗人', abstract_plain: '李白，唐代诗人。' };
test('Baidu information declares the encyclopedia capability and asks the content endpoint', async () => {
    assert.ok(baiduAdapter.capabilities.includes('information'));
    const calls = [];
    const out = await baiduAdapter.information(context(calls, [{ code: '0', result: LEMMA }]), { query: '李白', kind: 'encyclopedia' });
    assert.equal(out.ok, true);
    if (out.ok) {
        assert.equal(out.data.type, 'encyclopedia');
        assert.equal(out.data.source, 'baidu');
    }
    assert.match(calls[0], /\/v2\/baike\/lemma\/get_content/);
});
test('Baidu information routes video requests to 秒懂, not to lemma content', async () => {
    const calls = [];
    const out = await baiduAdapter.information(context(calls, [{ code: '0', result: { items: [] } }]), { query: '李白', kind: 'video' });
    assert.equal(out.ok, true);
    assert.match(calls[0], /second_know\/search_video/);
});
test('Baidu fetch resolves an /item/<name>/<id> URL by id and echoes the requested URL', async () => {
    const calls = [];
    const url = 'https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/123';
    const out = await baiduAdapter.fetch(context(calls, [{ code: '0', result: LEMMA }]), { url });
    assert.equal(out.ok, true);
    if (out.ok) {
        assert.equal(out.data.url, url);
        assert.equal(out.data.title, '李白');
        assert.ok((out.data.content ?? '').includes('唐代诗人'));
    }
    assert.match(calls[0], /search_type=lemmaId/);
});
test('Baidu fetch refuses a different sense instead of passing it off as the requested page', async () => {
    const calls = [];
    const url = 'https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/999';
    const out = await baiduAdapter.fetch(context(calls, [{ code: '0', result: LEMMA }]), { url });
    assert.equal(out.ok, false, 'a mismatched lemma id must fall back, not be returned as this page');
});
test('Baidu fetch ignores non-Baike URLs so the ordinary chain handles them', async () => {
    const out = await baiduAdapter.fetch(context([], [{}]), { url: 'https://example.com/article' });
    assert.equal(out.ok, false);
});
//# sourceMappingURL=baidu-adapter-info.test.js.map