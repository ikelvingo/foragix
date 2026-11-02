import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIT, decodeReasons, isUsable, isKnownMask, PERIOD_IRRELEVANT_BIT_MASK } from '../src/db/bits.js';

test('bit definitions do not overlap', () => {
  const values = Object.values(BIT);
  const union = values.reduce((a, b) => a | b, 0);
  const sum = values.reduce((a, b) => a + b, 0);
  assert.equal(union, sum, 'bits must not overlap');
});

test('isUsable is true only when the mask is 0', () => {
  assert.equal(isUsable(0), true);
  assert.equal(isUsable(BIT.QUOTA_DAY), false);
  assert.equal(isUsable(BIT.QUOTA_DAY | BIT.CREDENTIAL_MISSING), false);
});

test('decodeReasons decodes every set reason', () => {
  assert.deepEqual(decodeReasons(0), []);
  assert.deepEqual(decodeReasons(BIT.QUOTA_MONTH), ['quota_exhausted_month']);
  assert.deepEqual(decodeReasons(BIT.CREDENTIAL_MISSING | BIT.QUOTA_MONTH), [
    'quota_exhausted_month',
    'credential_missing',
  ]);
});

test('decodeReasons reports unknown for undefined bits instead of silently ignoring them', () => {
  assert.deepEqual(decodeReasons(1 << 20), ['unknown']);
});

test('isKnownMask rejects undefined bits and non-integers', () => {
  assert.equal(isKnownMask(BIT.TRANSIENT | BIT.PAID_NOT_ALLOWED), true);
  assert.equal(isKnownMask(1 << 20), false);
  assert.equal(isKnownMask(-1), false);
  assert.equal(isKnownMask(1.5), false);
});

test('the period-irrelevant mask still covers the credential bits (PAID is retired)', () => {
  for (const bit of [BIT.CREDENTIAL_MISSING, BIT.CREDENTIAL_REJECTED]) {
    assert.ok((PERIOD_IRRELEVANT_BIT_MASK & bit) !== 0, `bit ${bit} should be a period-irrelevant bit`);
  }
  // Quota bits are not among them — they are exactly what a period boundary is meant to clear
  assert.equal((PERIOD_IRRELEVANT_BIT_MASK & BIT.QUOTA_DAY), 0);
  assert.equal((PERIOD_IRRELEVANT_BIT_MASK & BIT.QUOTA_MONTH), 0);
});
