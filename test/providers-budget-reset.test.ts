/**
 * Lane A + local budget integration tests.
 *
 *  - brave: the only schema.localCap provider — a locally counted monthly ceiling is
 *    enforced BEFORE the request (a refusal state is persisted, the provider is skipped
 *    this round), and `capped_free: false` removes the brake entirely.
 *  - minimax: lane A — after a quota refusal the engine probes the vendor read endpoint
 *    (at most once per window) and persists the vendor-declared boundary; the boundary
 *    reached clears QUOTA_UNKNOWN so the provider crawls back into the pool on its own.
 *  - zhipu: lane A in-band — the verified `1308` refusal carries the reset time in its
 *    own message ("将在 <time> 重置", Beijing time); the engine records it with zero
 *    extra requests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './engine.test.js';
import { BIT } from '../src/db/bits.js';
import { zhipuAdapter } from '../src/providers/zhipu/index.js';
import { minimaxCnAdapter } from '../src/providers/minimax/index.js';
import { braveAdapter } from '../src/providers/brave/index.js';
const braveAdapterForTests = braveAdapter;
const minimaxAdapterForTests = minimaxCnAdapter;

const t0 = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00 UTC

test('brave local budget: ceiling reached → refused before the request, state persisted', async () => {
  const h = makeEngine({
    now: () => t0,
    yaml: 'version: 1\nproviders:\n  - id: brave\n    enabled: true\n    credentials:\n      - name: BRAVE_API_KEY\n        required: true\n    account: {}\n',
    adapters: [braveAdapterForTests],
    env: { BRAVE_API_KEY: 'k-brave' },
    routes: { 'https://api.search.brave.com/res/v1/web/search?q=q': { status: 200, body: JSON.stringify({ web: { results: [] } }) } },
  });
  h.db.ensureProvider('brave');
  h.db.resetPeriod('brave', 'month', '2026-11');
  h.db.addUsed('brave', 'month', 1_000); // ceiling already consumed before the call

  const result = await h.engine.search({ query: 'q' });

  assert.equal(result.ok, false);
  const report = result.providers.find((p) => p.id === 'brave');
  assert.ok(report !== undefined, 'brave appears in the refusal report');
  assert.ok(report.state.includes('quota_exhausted_month'), 'the monthly quota bit drives the refusal state');
  assert.equal(report.usable, false);
  // The change log records structural labels only — the free-text evidence belongs to the
  // report, not the log. The budget brake is identifiable through its labeled set-bit event.
  const log = h.db.recentChanges('brave');
  assert.ok(log.some((e) => e.kind === 'bit_set' && /quota_exhausted_month/.test(e.detail ?? '')), 'the budget refusal is labeled structurally');
  assert.ok(log.every((e) => !/k-brave/.test(e.detail ?? '')), 'no credential value may reach the log');
  const row = h.db.getProvider('brave');
  assert.notEqual((row?.is_available ?? 0) & BIT.QUOTA_MONTH, 0, 'the refusal persists as the monthly quota bit');
  assert.equal(row?.month_used, 1_000, 'no extra usage is booked for a refused call');
  h.close();
});

test('brave local budget: capped_free false removes the brake and the call goes out', async () => {
  const yaml = `
version: 1
providers:
  - id: brave
    enabled: true
    priority: 10
    credentials:
      - name: BRAVE_API_KEY
        required: true
    account:
      capped_free: false
`;
  const h = makeEngine({
    now: () => t0,
    yaml,
    adapters: [braveAdapterForTests],
    env: { BRAVE_API_KEY: 'k-brave' },
    routes: {
      'https://api.search.brave.com/res/v1/web/search?q=q': {
        status: 200,
        body: JSON.stringify({ web: { results: [{ title: 'T', url: 'https://x', description: 'D' }] } }),
      },
    },
  });
  h.db.ensureProvider('brave');
  h.db.resetPeriod('brave', 'month', '2026-11');
  h.db.addUsed('brave', 'month', 1_000);

  const result = await h.engine.search({ query: 'q' });
  assert.equal(result.ok, true, 'with the cap removed the request must go out despite the local counter');
  h.close();
});

test('minimax lane A: refusal probes the plan read once and persists the declared boundary', async () => {
  const clock = { now: t0 };
  const boundary = t0 + 60 * 60 * 1000; // the vendor window ends one hour later
  const h = makeEngine({
    now: () => clock.now,
    yaml: 'version: 1\nproviders:\n  - id: minimax_cn\n    enabled: true\n    credentials:\n      - name: MINIMAX_API_KEY\n        required: true\n    account: {}\n',
    adapters: [minimaxAdapterForTests],
    env: { MINIMAX_API_KEY: 'k-mm' },
    routes: {
      'https://api.minimax.cn/v1/coding_plan/search': {
        status: 200,
        body: JSON.stringify({ base_resp: { status_code: 1028, status_msg: 'quota exhausted' } }),
      },
      'https://api.minimax.cn/v1/token_plan/remains': {
        status: 200,
        body: JSON.stringify({ model_remains: [{ model_name: 'general', end_time: boundary }, { model_name: 'video', end_time: boundary }] }),
      },
    },
  });

  const first = await h.engine.search({ query: 'q' });
  assert.equal(first.ok, false);
  assert.equal(h.db.readVendorReset('minimax_cn'), boundary, 'the declared boundary is persisted once');
  assert.notEqual((h.db.getProvider('minimax_cn')?.is_available ?? 0) & BIT.QUOTA_UNKNOWN, 0);

  // Beyond the vendor boundary the gate clears the bit and the provider re-enters the pool.
  // The (fixed) vendor read now reports an outlived window: the engine degrades to
  // QUOTA_UNKNOWN instead of inventing a recovery time — the honest third state.
  clock.now = boundary + 1000;
  const second = await h.engine.search({ query: 'q' });
  assert.equal(second.ok, false);
  assert.notEqual((h.db.getProvider('minimax_cn')?.is_available ?? 0) & BIT.QUOTA_UNKNOWN, 0, 'still refusing without a declared live boundary');
  assert.equal(h.db.readVendorReset('minimax'), null, 'no fabricated reset time is stored');
  h.close();
});

test('zhipu lane A in-band: the 1308 message carries the reset time, zero extra requests', async () => {
  const clock = { now: t0 };
  const h = makeEngine({
    now: () => clock.now,
    yaml: 'version: 1\nproviders:\n  - id: zhipu\n    enabled: true\n    credentials:\n      - name: ZHIPU_API_KEY\n        required: true\n    account: {}\n',
    adapters: [zhipuAdapter],
    env: { ZHIPU_API_KEY: 'k-zp' },
    routes: {
      'https://open.bigmodel.cn/api/paas/v4/web_search': {
        status: 429,
        body: JSON.stringify({ error: { code: '1308', message: '已达到 100 searches 的使用上限。您的限额将在 2026-11-04 02:00:00 重置' } }),
      },
    },
  });

  await h.engine.search({ query: 'q' });
  const expected = Date.parse('2026-11-04T02:00:00+08:00');
  assert.equal(h.db.readVendorReset('zhipu'), expected, 'in-band boundary persisted without any probe request');
  h.close();
});
