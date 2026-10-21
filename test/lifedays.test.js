// ============================================================================
// LunaCore - Life dashboard local days + ISO weeks (src/lifedays.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ymd, parseDay, isDay, addDays, dayDiff, mondayOf, isoWeek, weekMonday, isWeek } = require('../src/lifedays.js');

test('ymd is the local calendar day', () => {
  assert.equal(ymd(new Date(2026, 9, 20, 23, 59)), '2026-10-20');
  assert.equal(ymd(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01-01');
});

test('parseDay refuses impossible days and out-of-range years', () => {
  assert.ok(parseDay('2028-02-29'));
  for (const bad of ['2027-02-29', '2026-13-01', '2026-10-32', '1999-01-01', '2101-01-01', '2026-1-1', 42, null]) {
    assert.equal(isDay(bad), false, String(bad));
  }
});

test('addDays crosses months, years and DST changes by calendar date', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  // Europe DST ends 2026-10-25, starts 2027-03-28: still one day per step.
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(addDays('2027-03-27', 2), '2027-03-29');
  assert.equal(dayDiff('2026-10-24', '2026-10-26'), 2);
  assert.equal(dayDiff('2027-03-29', '2027-03-27'), -2);
});

test('mondayOf is the local Monday', () => {
  assert.equal(mondayOf('2026-10-20'), '2026-10-19');
  assert.equal(mondayOf('2026-10-19'), '2026-10-19');
  assert.equal(mondayOf('2026-10-25'), '2026-10-19');
  assert.equal(mondayOf('2027-01-01'), '2026-12-28');
});

test('isoWeek follows ISO 8601 at year boundaries', () => {
  assert.equal(isoWeek('2026-10-20'), '2026-W43');
  // 2026 has 53 ISO weeks (Jan 1 2026 is a Thursday).
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2026-12-31'), '2026-W53');
  assert.equal(isoWeek('2027-01-03'), '2026-W53');
  assert.equal(isoWeek('2027-01-04'), '2027-W01');
  // Dec 29 2025 (Monday) already belongs to 2026-W01.
  assert.equal(isoWeek('2025-12-29'), '2026-W01');
  assert.equal(isoWeek('2025-12-28'), '2025-W52');
  // 2021-01-03 (Sunday) is in 2020-W53.
  assert.equal(isoWeek('2021-01-03'), '2020-W53');
  assert.equal(isoWeek('2024-12-30'), '2025-W01');
});

test('weekMonday inverts isoWeek and refuses weeks a year does not have', () => {
  assert.equal(weekMonday('2026-W43'), '2026-10-19');
  assert.equal(weekMonday('2026-W01'), '2025-12-29');
  assert.equal(weekMonday('2026-W53'), '2026-12-28');
  assert.equal(isWeek('2027-W53'), false);
  for (const bad of ['2026-W00', '2026-W54', '2026-43', 'x', null, '1999-W10']) assert.equal(isWeek(bad), false, String(bad));
});
