import { test } from 'node:test';
import assert from 'node:assert/strict';

async function targets(): Promise<{ parseBaikeUrl: (url: string) => { searchType: 'lemmaId' | 'lemmaTitle'; searchKey: string } | null }> {
  const specifier = '../src/providers/baidu/target.js';
  try { return await import(specifier); } catch { return assert.fail('Baidu target parser must be available'); }
}

test('Baidu Baike URLs yield the numeric lemma id when present', async () => {
  const { parseBaikeUrl } = await targets();
  assert.deepEqual(parseBaikeUrl('https://baike.baidu.com/item/%E6%9D%8E%E7%99%BD/123'), { searchType: 'lemmaId', searchKey: '123' });
  assert.deepEqual(parseBaikeUrl('https://baike.baidu.com/item/李白'), { searchType: 'lemmaTitle', searchKey: '李白' });
});

test('Baidu Baike parser rejects lookalike hosts, other paths and credentials in the URL', async () => {
  const { parseBaikeUrl } = await targets();
  assert.equal(parseBaikeUrl('https://baike.baidu.com.evil.example/item/x/1'), null);
  assert.equal(parseBaikeUrl('https://evil.example/baike.baidu.com/item/x/1'), null);
  assert.equal(parseBaikeUrl('https://user:pass@baike.baidu.com/item/x/1'), null);
  assert.equal(parseBaikeUrl('http://baike.baidu.com/item/x/1'), null);
  assert.equal(parseBaikeUrl('https://baike.baidu.com/other/x/1'), null);
  assert.equal(parseBaikeUrl('not a url'), null);
});
