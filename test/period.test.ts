import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, monthKey, periodKeys, isValidTimezone, DEFAULT_TIMEZONE } from '../src/db/period.js';

/** 2026-10-29T23:30:00Z — in UTC this is the 29th, while in Asia/Shanghai (+8) it is already the 30th */
const T = Date.UTC(2026, 9, 29, 23, 30, 0);

test('the day key is computed in the given timezone, not the local timezone of the machine it runs on', () => {
  assert.equal(dayKey('UTC', T), '2026-10-29');
  assert.equal(dayKey('Asia/Shanghai', T), '2026-10-30');
});

test('the month key changes correctly when crossing a month', () => {
  const endOfMonth = Date.UTC(2026, 9, 31, 20, 0, 0);
  assert.equal(monthKey('UTC', endOfMonth), '2026-10');
  assert.equal(monthKey('Asia/Shanghai', endOfMonth), '2026-11', 'UTC+8 has already entered November');
});

test('year boundary', () => {
  const nye = Date.UTC(2026, 11, 31, 20, 0, 0);
  assert.equal(monthKey('UTC', nye), '2026-12');
  assert.equal(monthKey('Asia/Shanghai', nye), '2027-01');
});

test('day keys can be compared directly in lexicographic order (the premise for deciding period key advancement)', () => {
  const a = dayKey('UTC', Date.UTC(2026, 9, 9, 12));
  const b = dayKey('UTC', Date.UTC(2026, 9, 10, 12));
  assert.ok(a < b, 'the lexicographic order of YYYY-MM-DD is chronological order');
});

test('the periodKeys month key agrees with the day key', () => {
  const keys = periodKeys('UTC', T);
  assert.equal(keys.day, '2026-10-29');
  assert.equal(keys.month, keys.day.slice(0, 7));
});

test('isValidTimezone blocks invalid timezones (so it does not blow up only at call time)', () => {
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Asia/Shanghai'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
  assert.equal(isValidTimezone(''), false);
});

test('the default timezone is UTC and does not drift with the local timezone of the machine', () => {
  assert.equal(DEFAULT_TIMEZONE, 'UTC');
});
