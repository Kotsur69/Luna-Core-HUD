// ============================================================================
// LunaCore - RRULE builder tests (src/gcalrecur.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { monthlyRule, yearlyRule, billRule, firstOccurrence } = require('../src/gcalrecur.js');

test('monthlyRule builds BYMONTHDAY from a validated day', () => {
  assert.equal(monthlyRule(1), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1');
  assert.equal(monthlyRule(28), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=28');
});

test('a day past the 28th clamps to the month end via BYSETPOS', () => {
  assert.equal(monthlyRule(30), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1');
  assert.equal(monthlyRule(31), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
});

test('anything but an integer 1-31 is refused - never text in an RRULE', () => {
  for (const bad of [0, 32, 1.5, '15', '15;COUNT=1', null, undefined, NaN, -1]) {
    assert.throws(() => monthlyRule(bad), /bad day/);
  }
});

test('yearlyRule validates the month too', () => {
  assert.equal(yearlyRule(3, 15), 'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15');
  assert.throws(() => yearlyRule(13, 1), /bad month/);
  assert.throws(() => yearlyRule('3', 1), /bad month/);
});

test('billRule picks the frequency from the bill', () => {
  assert.equal(billRule({ every: 'month', dueDay: 10, month: 0 }), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=10');
  assert.equal(billRule({ every: 'year', dueDay: 10, month: 6 }), 'RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=10');
});

test('firstOccurrence: this month when the day is still ahead, else next month', () => {
  assert.deepEqual(firstOccurrence({ dueDay: 25, every: 'month' }, '2026-10-20'), { start: '2026-10-25', end: '2026-10-26' });
  assert.deepEqual(firstOccurrence({ dueDay: 20, every: 'month' }, '2026-10-20'), { start: '2026-10-20', end: '2026-10-21' });
  assert.deepEqual(firstOccurrence({ dueDay: 5, every: 'month' }, '2026-12-20'), { start: '2027-01-05', end: '2027-01-06' });
});

test('firstOccurrence clamps to short months and rolls the year for yearly bills', () => {
  assert.deepEqual(firstOccurrence({ dueDay: 31, every: 'month' }, '2027-02-10'), { start: '2027-02-28', end: '2027-03-01' });
  assert.deepEqual(firstOccurrence({ dueDay: 1, every: 'year', month: 3 }, '2026-10-20'), { start: '2027-03-01', end: '2027-03-02' });
  assert.deepEqual(firstOccurrence({ dueDay: 15, every: 'year', month: 11 }, '2026-10-20'), { start: '2026-11-15', end: '2026-11-16' });
});
