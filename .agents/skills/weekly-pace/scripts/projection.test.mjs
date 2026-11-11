// node --test scripts/projection.test.mjs
// 時刻はローカル時刻で組むので、どのタイムゾーンで流しても同じ結果になる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeHoursBetween, activeHoursFrom, parseActiveHours, project, verdictOf } from './projection.mjs';

const t = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const noonToEight = { start: 12, end: 20 };

test('稼働の時間帯の中の時間だけを数える', () => {
  assert.equal(activeHoursBetween(t(2, 0), t(3, 0), noonToEight), 8);
  assert.equal(activeHoursBetween(t(2, 13), t(2, 15, 30), noonToEight), 2.5);
  assert.equal(activeHoursBetween(t(2, 20), t(3, 12), noonToEight), 0);
  assert.equal(activeHoursBetween(t(2, 18), t(3, 13), noonToEight), 3);
  assert.equal(activeHoursBetween(t(2, 0), t(9, 0), noonToEight), 56);
});

test('日をまたぐ時間帯と終日を数える', () => {
  const night = { start: 22, end: 6 };
  assert.equal(activeHoursBetween(t(2, 0), t(3, 0), night), 8);
  assert.equal(activeHoursBetween(t(2, 23), t(3, 2), night), 3);
  assert.equal(activeHoursBetween(t(2, 5), t(2, 9), { start: 0, end: 24 }), 4);
});

test('時間帯の書き方を読む', () => {
  assert.deepEqual(parseActiveHours('9-17'), { start: 9, end: 17 });
  assert.deepEqual(parseActiveHours(' 22 - 6 '), { start: 22, end: 6 });
  for (const bad of ['', '12', '12-12', '24-6', '9-25', 'a-b', undefined]) assert.throws(() => parseActiveHours(bad));
  assert.deepEqual(activeHoursFrom(['--active-hours', '8-16'], { WEEKLY_PACE_ACTIVE_HOURS: '1-9' }), { start: 8, end: 16 });
  assert.deepEqual(activeHoursFrom([], { WEEKLY_PACE_ACTIVE_HOURS: '1-9' }), { start: 1, end: 9 });
  assert.deepEqual(activeHoursFrom([], {}), { start: 12, end: 20 });
});

test('稼働の時間で着地見込みを出し、時間帯の外では動かない', () => {
  // 2日の 0 時に始まった 168h の枠。3日の 12 時の時点で稼働は 8h。
  const base = { pct: 20, resetsAtMs: t(9, 0), windowHours: 168, activeHours: noonToEight };
  const evening = project({ ...base, nowMs: t(2, 20) });
  const nextMorning = project({ ...base, nowMs: t(3, 11) });
  assert.equal(evening.activeTotalHours, 56);
  assert.equal(evening.projected, 140);
  assert.equal(nextMorning.projected, 140);
  assert.equal(evening.verdict, 'ハイペース');
  assert.equal(project({ ...base, nowMs: t(2, 13) }).projected, null);
});

test('判定の区切り', () => {
  assert.equal(verdictOf(null), null);
  assert.equal(verdictOf(100.1), 'ハイペース');
  assert.equal(verdictOf(100), '順調');
  assert.equal(verdictOf(70), '順調');
  assert.equal(verdictOf(69.9), 'ローペース');
});
