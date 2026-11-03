import { test } from 'node:test';
import assert from 'node:assert/strict';
function context(calls, payload) {
    const fetchImpl = (async (input, init) => {
        calls.push(String(input));
        assert.equal((init?.headers)['authorization'], 'Bearer fake-key');
        return new Response(JSON.stringify(payload), { status: 200 });
    });
    return {
        credentials: { get: () => 'fake-key', has: () => true, fingerprint: () => 'fake', describe: () => [] },
        config: { id: 'baidu', enabled: true, priority: 1, credentials: [], account: {}, allowPaid: null },
        fetchImpl, now: () => 1700000000000, credentialNames: [],
    };
}
async function client() {
    const path = '../src/providers/baidu/encyclopedia.js';
    try {
        return await import(path);
    }
    catch {
        return assert.fail('Baidu encyclopedia client must be available');
    }
}
test('Baidu encyclopedia content requests the official ID endpoint and preserves returned fields', async () => {
    const calls = [];
    const data = { lemma_id: 123, lemma_title: '李白', url: 'https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/123', summary: '简介', future_field: { nested: true } };
    const { getContent } = await client();
    const result = await getContent(context(calls, { code: '0', result: data }), 'lemmaId', '123');
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.data, data);
    const url = new URL(calls[0]);
    assert.equal(url.hostname, 'appbuilder.baidu.com');
    assert.equal(url.pathname, '/v2/baike/lemma/get_content');
    assert.equal(url.searchParams.get('search_type'), 'lemmaId');
    assert.equal(url.searchParams.get('search_key'), '123');
});
test('Baidu encyclopedia list sends the title and clamps top_k', async () => {
    const calls = [];
    const senses = [{ lemma_id: 1, lemma_title: '李白', is_default: true }];
    const { listByTitle } = await client();
    const result = await listByTitle(context(calls, { code: '0', result: senses }), '李白', 500);
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.data, senses);
    const url = new URL(calls[0]);
    assert.equal(url.pathname, '/v2/baike/lemma/get_list_by_title');
    assert.equal(url.searchParams.get('lemma_title'), '李白');
    assert.equal(url.searchParams.get('top_k'), '100');
});
test('Baidu 秒懂 video uses the qianfan host and its own endpoint', async () => {
    const calls = [];
    const { searchVideo } = await client();
    const result = await searchVideo(context(calls, { code: '0', result: { items: [] } }), 'lemmaTitle', '李白');
    assert.equal(result.ok, true);
    const url = new URL(calls[0]);
    assert.equal(url.hostname, 'qianfan.baidubce.com');
    assert.equal(url.pathname, '/v2/baike/second_know/search_video');
    assert.equal(url.searchParams.get('search_key'), '李白');
});
test('Baidu encyclopedia in-band error code is a failure, not an empty success', async () => {
    const { getContent } = await client();
    const result = await getContent(context([], { code: '1', message: 'invalid parameter' }), 'lemmaId', '0');
    assert.equal(result.ok, false);
});
//# sourceMappingURL=baidu-encyclopedia.test.js.map