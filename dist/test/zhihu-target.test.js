import { test } from 'node:test';
import assert from 'node:assert/strict';
async function targets() {
    const specifier = '../src/providers/zhihu/target.js';
    try {
        return await import(specifier);
    }
    catch {
        return assert.fail('Zhihu target parser must be available');
    }
}
test('Zhihu content URLs are canonicalised to https without query or fragment', async () => {
    const { parseZhihuUrl } = await targets();
    assert.equal(parseZhihuUrl('https://www.zhihu.com/question/1/answer/2'), 'https://www.zhihu.com/question/1/answer/2');
    assert.equal(parseZhihuUrl('https://zhuanlan.zhihu.com/p/99?utm=1#x'), 'https://zhuanlan.zhihu.com/p/99');
    assert.equal(parseZhihuUrl('https://zhihu.com/answer/5'), 'https://zhihu.com/answer/5');
    assert.equal(parseZhihuUrl('https://www.zhihu.com/pin/7'), 'https://www.zhihu.com/pin/7');
});
test('Zhihu parser rejects lookalikes, plain http, userinfo and unsupported paths', async () => {
    const { parseZhihuUrl } = await targets();
    assert.equal(parseZhihuUrl('https://zhihu.com.evil.example/question/1/answer/2'), null);
    assert.equal(parseZhihuUrl('https://evil.example/zhihu.com/question/1'), null);
    assert.equal(parseZhihuUrl('http://www.zhihu.com/question/1/answer/2'), null);
    assert.equal(parseZhihuUrl('https://u:p@www.zhihu.com/question/1/answer/2'), null);
    assert.equal(parseZhihuUrl('https://www.zhihu.com/people/someone'), null);
    assert.equal(parseZhihuUrl('https://www.zhihu.com/search?q=x'), null);
});
//# sourceMappingURL=zhihu-target.test.js.map