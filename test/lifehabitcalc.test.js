// ============================================================================
// LunaCore - habit streak math (src/lifehabitcalc.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dailyStreak, weeklyStreak, habitStatus, dayHabits } = require('../src/lifehabitcalc.js');

const TODAY = '2026-10-21'; // Wednesday

test('daily streak counts back from today, or from yesterday while today is open', () => {
  assert.equal(dailyStreak(new Set(['2026-10-19', '2026-10-20', '2026-10-21']), TODAY), 3);
  assert.equal(dailyStreak(new Set(['2026-10-19', '2026-10-20']), TODAY), 2);
  assert.equal(dailyStreak(new Set(['2026-10-19']), TODAY), 0);
  assert.equal(dailyStreak(new Set(), TODAY), 0);
});

test('daily streak walks across the DST change by calendar day', () => {
  // Europe: clocks go back on 2026-10-25.
  const days = new Set(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  assert.equal(dailyStreak(days, '2026-10-27'), 4);
});

test('weekly streak counts consecutive Mon-Sun weeks that met N', () => {
  const done = new Set([
    // W41 (Oct 5-11): 3 ticks
    '2026-10-05', '2026-10-07', '2026-10-09',
    // W42 (Oct 12-18): 3 ticks, one on Sunday
    '2026-10-12', '2026-10-14', '2026-10-18',
    // W43 (current): 1 so far
    '2026-10-20',
  ]);
  // The current week is not over: it does not break the streak yet.
  assert.equal(weeklyStreak(done, 3, TODAY), 2);
  assert.equal(weeklyStreak(new Set([...done, '2026-10-21', '2026-10-21x']), 2, TODAY), 3);
  // W42 short of 4 -> the streak is 0.
  assert.equal(weeklyStreak(done, 4, TODAY), 0);
});

test('habitStatus merges auto days (YAZIO steps) with manual ticks', () => {
  const habit = { id: 'steps', every: 'day', perWeek: 7, auto: 'steps', done: ['2026-10-20'] };
  const s = habitStatus(habit, TODAY, { steps: new Set(['2026-10-21']) });
  assert.equal(s.doneToday, true);
  assert.equal(s.autoToday, true);
  assert.equal(s.doneYesterday, true);
  assert.equal(s.streak, 2);
  const plain = habitStatus({ ...habit, auto: '' }, TODAY, { steps: new Set(['2026-10-21']) });
  assert.equal(plain.doneToday, false);
});

test('habitStatus reports week progress for N-per-week habits', () => {
  const s = habitStatus({ id: 'gym', every: 'week', perWeek: 3, auto: '', done: ['2026-10-19', '2026-10-21', '2026-10-18'] }, TODAY, {});
  assert.equal(s.weekCount, 2);
  assert.equal(s.doneToday, true);
});

test('dayHabits counts daily habits only; none -> null', () => {
  const habits = [
    { id: 'a', every: 'day', perWeek: 7, auto: '', done: ['2026-10-21'] },
    { id: 'b', every: 'day', perWeek: 7, auto: '', done: [] },
    { id: 'c', every: 'week', perWeek: 3, auto: '', done: ['2026-10-21'] },
  ];
  assert.deepEqual(dayHabits(habits, TODAY, {}), { done: 1, due: 2 });
  assert.equal(dayHabits([habits[2]], TODAY, {}), null);
});
