import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSelection, selectFirst, isUsable, compareCandidates } from '../src/routing/select.js';
import { BIT } from '../src/db/bits.js';
function candidate(over) {
    return {
        priority: 10,
        isEnable: true,
        isAvailable: 0,
        capabilities: ['search'],
        ...over,
    };
}
test('call condition: both bits true/zero', () => {
    assert.equal(isUsable(candidate({ providerId: 'a' })), true);
    assert.equal(isUsable(candidate({ providerId: 'a', isEnable: false })), false);
    assert.equal(isUsable(candidate({ providerId: 'a', isAvailable: BIT.QUOTA_DAY })), false);
});
test('filtering by capability: a provider that does not declare the capability does not enter the candidate set', () => {
    const plan = planSelection([
        candidate({ providerId: 'a', capabilities: ['search'] }),
        candidate({ providerId: 'b', capabilities: ['fetch'] }),
    ], 'fetch');
    assert.deepEqual(plan.ordered.map((c) => c.providerId), ['b']);
    assert.equal(plan.noneWithCapability, false);
});
test('when no provider declares the capability an explicit flag is given, instead of silently returning empty', () => {
    const plan = planSelection([candidate({ providerId: 'a', capabilities: ['search'] })], 'fetch');
    assert.equal(plan.noneWithCapability, true);
    assert.equal(plan.ordered.length, 0);
});
test('ordered by priority ascending', () => {
    const plan = planSelection([
        candidate({ providerId: 'a', priority: 30 }),
        candidate({ providerId: 'b', priority: 10 }),
        candidate({ providerId: 'c', priority: 20 }),
    ], 'search');
    assert.deepEqual(plan.ordered.map((c) => c.providerId), ['b', 'c', 'a']);
});
test('same priority orders by provider id ascending — giving "ties" a determinate resolution', () => {
    const plan = planSelection([
        candidate({ providerId: 'zeta', priority: 10 }),
        candidate({ providerId: 'alpha', priority: 10 }),
        candidate({ providerId: 'mid', priority: 10 }),
    ], 'search');
    assert.deepEqual(plan.ordered.map((c) => c.providerId), ['alpha', 'mid', 'zeta']);
});
test('routing is a pure function: the input order does not affect the result', () => {
    const items = [
        candidate({ providerId: 'c', priority: 20 }),
        candidate({ providerId: 'a', priority: 10 }),
        candidate({ providerId: 'b', priority: 10 }),
    ];
    const forward = planSelection(items, 'search').ordered.map((c) => c.providerId);
    const backward = planSelection([...items].reverse(), 'search').ordered.map((c) => c.providerId);
    assert.deepEqual(forward, backward);
    assert.deepEqual(forward, ['a', 'b', 'c']);
});
test('routing contains no randomness: the same input recomputed repeatedly yields the same result', () => {
    const items = [
        candidate({ providerId: 'b', priority: 10 }),
        candidate({ providerId: 'a', priority: 10 }),
        candidate({ providerId: 'c', priority: 10 }),
    ];
    const first = planSelection(items, 'search').ordered.map((c) => c.providerId).join(',');
    for (let i = 0; i < 50; i += 1) {
        assert.equal(planSelection(items, 'search').ordered.map((c) => c.providerId).join(','), first);
    }
});
test('a provider turned off by is_enable is excluded, and the reason is recorded as disabled', () => {
    const plan = planSelection([candidate({ providerId: 'a', isEnable: false })], 'search');
    assert.equal(plan.ordered.length, 0);
    assert.equal(plan.excluded.length, 1);
    assert.equal(plan.excluded[0]?.reason, 'disabled');
});
test('a provider whose bitmask is non-zero is excluded, and the reason is recorded as unavailable', () => {
    const plan = planSelection([candidate({ providerId: 'a', isAvailable: BIT.CREDENTIAL_MISSING })], 'search');
    assert.equal(plan.ordered.length, 0);
    assert.equal(plan.excluded[0]?.reason, 'unavailable');
});
test('when multiple reasons coexist it still counts as only one exclusion', () => {
    const plan = planSelection([candidate({ providerId: 'a', isAvailable: BIT.CREDENTIAL_MISSING | BIT.QUOTA_MONTH })], 'search');
    assert.equal(plan.excluded.length, 1);
    assert.equal(plan.ordered.length, 0);
});
test('compareCandidates compares priority first, then id', () => {
    assert.ok(compareCandidates(candidate({ providerId: 'a', priority: 1 }), candidate({ providerId: 'b', priority: 2 })) < 0);
    assert.ok(compareCandidates(candidate({ providerId: 'b', priority: 1 }), candidate({ providerId: 'a', priority: 1 })) > 0);
    assert.equal(compareCandidates(candidate({ providerId: 'a', priority: 1 }), candidate({ providerId: 'a', priority: 1 })), 0);
});
test('selectFirst returns the first choice, and null when there are no candidates', () => {
    const plan = planSelection([candidate({ providerId: 'b', priority: 20 }), candidate({ providerId: 'a', priority: 10 })], 'search');
    assert.equal(selectFirst(plan)?.providerId, 'a');
    assert.equal(selectFirst(planSelection([], 'search')), null);
});
test('when the usable set is empty but excluded candidates exist, the reason is visible in excluded', () => {
    const plan = planSelection([
        candidate({ providerId: 'a', isAvailable: BIT.QUOTA_DAY }),
        candidate({ providerId: 'b', isEnable: false }),
    ], 'search');
    assert.equal(plan.ordered.length, 0);
    assert.deepEqual(plan.excluded.map((e) => [e.candidate.providerId, e.reason]), [
        ['a', 'unavailable'],
        ['b', 'disabled'],
    ]);
});
//# sourceMappingURL=routing.test.js.map