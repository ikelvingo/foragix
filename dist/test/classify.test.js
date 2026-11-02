import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, classifyNetworkError, parseRetryAfter, clampCooldown, backoffMs, extractErrorCode, COOLDOWN_MIN_MS, COOLDOWN_MAX_MS, } from '../src/errors/classify.js';
const NOW = Date.UTC(2026, 9, 29, 12);
test('2xx is classified as success', () => {
    for (const status of [200, 201, 204]) {
        assert.equal(classifyResponse({ status }, NOW).kind, 'success');
    }
});
test('402 is classified as quota exhausted—v0.1 was missing that status entirely (Exa uses it)', () => {
    const result = classifyResponse({ status: 402 }, NOW);
    assert.equal(result.kind, 'quota');
});
test('401 is classified as credential rejected', () => {
    assert.equal(classifyResponse({ status: 401 }, NOW).kind, 'credential_rejected');
});
test('403 is told apart by the response body: authentication semantics → credential rejected', () => {
    const result = classifyResponse({ status: 403, body: JSON.stringify({ error: 'invalid api key' }) }, NOW);
    assert.equal(result.kind, 'credential_rejected');
});
test('403 is told apart by the response body: quota semantics → quota exhausted', () => {
    const result = classifyResponse({ status: 403, body: JSON.stringify({ message: 'monthly quota exceeded, please upgrade' }) }, NOW);
    assert.equal(result.kind, 'quota');
});
test('403 with no usable semantics sets no flags—assume neither that it is our problem nor that it is quota', () => {
    const result = classifyResponse({ status: 403, body: 'Forbidden' }, NOW);
    assert.equal(result.kind, 'our_problem');
});
test('429 with quota semantics → quota exhausted (Retry-After alone cannot prove a short window)', () => {
    // some providers also send Retry-After when the monthly quota is exhausted
    const result = classifyResponse({
        status: 429,
        headers: { 'retry-after': '30' },
        body: JSON.stringify({ error: 'monthly credit limit reached' }),
    }, NOW);
    assert.equal(result.kind, 'quota', 'quota semantics must take precedence over Retry-After');
});
test('429 with a short Retry-After → short-window rate limiting', () => {
    const result = classifyResponse({ status: 429, headers: { 'retry-after': '5' } }, NOW);
    assert.equal(result.kind, 'rate_limited_short');
});
test('429 with rate-limit headers → short-window rate limiting', () => {
    const result = classifyResponse({ status: 429, headers: { 'x-ratelimit-limit': '30' } }, NOW);
    assert.equal(result.kind, 'rate_limited_short');
});
test('429 with no signal at all defaults to the short window—asymmetric cost', () => {
    const result = classifyResponse({ status: 429 }, NOW);
    assert.equal(result.kind, 'rate_limited_short');
});
test('5xx / 529 / 408 are classified as transient failure', () => {
    for (const status of [408, 500, 502, 503, 504, 529]) {
        assert.equal(classifyResponse({ status }, NOW).kind, 'transient', `HTTP ${status}`);
    }
});
test('400 / 404 / 413 / 422 default into our problem, and set no flags', () => {
    for (const status of [400, 404, 413, 422]) {
        const result = classifyResponse({ status }, NOW);
        assert.equal(result.kind, 'our_problem', `HTTP ${status}`);
    }
});
test('a verified status-code mapping takes precedence over the generic heuristics', () => {
    const result = classifyResponse({
        status: 400,
        hints: { statusMap: { 400: { kind: 'quota', period: 'month', evidence: 'verified' } } },
    }, NOW);
    assert.equal(result.kind, 'quota', 'per-adapter verification must beat the default rules');
});
test('a verified error code can be classified as quota exhausted', () => {
    const result = classifyResponse({
        status: 400,
        body: JSON.stringify({ code: '10406', message: 'free quota exhausted' }),
        hints: { quotaErrorCodes: ['10406'] },
    }, NOW);
    assert.equal(result.kind, 'quota');
});
test('a verified error code can be classified as credential rejected', () => {
    const result = classifyResponse({ status: 200, body: JSON.stringify({ code: 'auth_invalid' }), hints: { authErrorCodes: ['auth_invalid'] } }, NOW);
    // even when the HTTP status is 200, a verified business error code must still take effect
    assert.equal(result.kind, 'credential_rejected');
});
test('network-layer failures are uniformly classified as transient, and the description carries no credential', () => {
    const result = classifyNetworkError(new Error('connect ECONNREFUSED'));
    assert.equal(result.kind, 'transient');
    assert.ok(!/key|token/i.test(result.evidence));
});
test('parseRetryAfter supports both the seconds form and the HTTP date form', () => {
    assert.equal(parseRetryAfter('30', NOW), 30_000);
    assert.equal(parseRetryAfter('0', NOW), 0);
    const future = new Date(NOW + 12_000).toUTCString();
    assert.equal(parseRetryAfter(future, NOW), 12_000);
    assert.equal(parseRetryAfter('garbage', NOW), null);
    assert.equal(parseRetryAfter(null, NOW), null);
});
test('the cooldown is clamped into [1s, 60s]—the upper bound guarantees a permanently broken provider is still retried once a minute', () => {
    assert.equal(clampCooldown(0), COOLDOWN_MIN_MS);
    assert.equal(clampCooldown(-5), COOLDOWN_MIN_MS);
    assert.equal(clampCooldown(5_000), 5_000);
    assert.equal(clampCooldown(999_999), COOLDOWN_MAX_MS);
    assert.equal(COOLDOWN_MAX_MS, 60_000);
});
test('exponential backoff grows 1s→2s→4s and caps at 60s', () => {
    assert.equal(backoffMs(1), 1_000);
    assert.equal(backoffMs(2), 2_000);
    assert.equal(backoffMs(3), 4_000);
    assert.equal(backoffMs(4), 8_000);
    assert.equal(backoffMs(7), 60_000, '64s should be clamped to 60s');
    assert.equal(backoffMs(999), COOLDOWN_MAX_MS, 'extreme values must not overflow');
});
test('extractErrorCode tolerates nesting and invalid JSON', () => {
    assert.equal(extractErrorCode(JSON.stringify({ code: '10406' })), '10406');
    assert.equal(extractErrorCode(JSON.stringify({ error: { code: 'x' } })), 'x');
    assert.equal(extractErrorCode('not json but code=abc here'), 'abc');
    assert.equal(extractErrorCode(''), null);
    assert.equal(extractErrorCode(undefined), null);
});
//# sourceMappingURL=classify.test.js.map