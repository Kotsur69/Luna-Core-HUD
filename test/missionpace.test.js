// ============================================================================
// LunaCore - Mission Control pace math tests (renderer/modules/missionpace.js)
// ----------------------------------------------------------------------------
// Pure functions with a fixed clock. Dates are local, like the widget's.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pace = require('../src/renderer/modules/missionpace.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily rows from `from` (local) for `n` days, each with count(i). */
function days(from, n, count) {
  const out = [];
  const d = new Date(from);
  for (let i = 0; i < n; i++) {
    out.push({ date: pace.dayKey(d), count: count(i) });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

test('weekElapsed: Monday midnight is 0, Sunday noon is 6.5/7', () => {
  assert.equal(pace.weekElapsed(new Date(2026, 9, 5, 0, 0)), 0);
  assert.ok(Math.abs(pace.weekElapsed(new Date(2026, 9, 11, 12, 0)) - 6.5 / 7) < 1e-9);
});

test('githubVelocity compares this week with the 4-week average, pro rata', () => {
  // Four full weeks of 2/day (14/week), then Mon-Wed of this week at 2/day.
  const rows = days(new Date(2026, 8, 7), 31, () => 2);
  const now = new Date(2026, 9, 8, 0, 0); // Thursday 00:00 -> 3/7 of the week
  const v = pace.githubVelocity(rows, now);
  assert.equal(v.avgWeek, 14);
  assert.equal(v.thisWeek, 6);
  assert.ok(Math.abs(v.pace - 1) < 1e-9);
  assert.equal(v.weeks.length, 8);
  assert.equal(v.weeks[7].count, 6);
});

test('githubVelocity has no average when the data does not cover a prior week', () => {
  const v = pace.githubVelocity(days(new Date(2026, 9, 5), 3, () => 1), new Date(2026, 9, 8, 9));
  assert.equal(v.avgWeek, null);
  assert.equal(v.pace, null);
});

test('quietDays counts zero days back from yesterday, ignoring today', () => {
  const rows = days(new Date(2026, 9, 1), 8, (i) => (i < 4 ? 5 : 0)); // Oct 5..8 are zero
  assert.equal(pace.githubVelocity(rows, new Date(2026, 9, 8, 10)).quietDays, 3);
});

test('heatmap: Monday-first columns, future days null, levels 0..4', () => {
  const rows = days(new Date(2026, 8, 28), 11, (i) => i); // Mon Sep 28 .. Thu Oct 8
  const cols = pace.heatmap(rows, new Date(2026, 9, 8, 10));
  assert.equal(cols.length, 2);
  assert.equal(cols[0][0].date, '2026-09-28');
  assert.equal(cols[0][0].level, 0);
  assert.equal(cols[1][3].level, 4);
  assert.equal(cols[1][4], null);
});

test('budgetPace: on-track, overburn with a hit time, and missing reset', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const half = new Date(now.getTime() + 3.5 * DAY_MS).toISOString();
  const onTrack = pace.budgetPace({ percentUsed: 50, resetsAt: half }, now);
  assert.ok(Math.abs(onTrack.pace - 1) < 1e-9);
  assert.equal(onTrack.hitsAt, null);
  const hot = pace.budgetPace({ percentUsed: 80, resetsAt: half }, now);
  assert.ok(Math.abs(hot.projected - 160) < 1e-9);
  // 80% in 3.5 days -> the remaining 20% takes 0.875 days.
  assert.ok(Math.abs(hot.hitsAt - (now.getTime() + 0.875 * DAY_MS)) < 1000);
  assert.equal(pace.budgetPace({ percentUsed: 10, resetsAt: null }, now), null);
});

test('paceFlags: late-week low output and low budget, overburn first, quiet streak', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const late = pace.budgetPace({ percentUsed: 8, resetsAt: new Date(now.getTime() + 0.5 * DAY_MS).toISOString() }, now);
  const velocity = { pace: 0.1, elapsed: 6.5 / 7, quietDays: 4 };
  assert.deepEqual(
    pace.paceFlags({ velocity, budget: late }).map((f) => f.key),
    ['lowOutput', 'lowBudget', 'quiet']
  );
  // Early in the week, the same low ratios are not flagged.
  const early = { pace: 0.1, elapsed: 2 / 7, quietDays: 0 };
  assert.deepEqual(pace.paceFlags({ velocity: early, budget: null }), []);
  const hot = pace.budgetPace({ percentUsed: 80, resetsAt: new Date(now.getTime() + 3.5 * DAY_MS).toISOString() }, now);
  assert.equal(pace.paceFlags({ velocity: null, budget: hot })[0].key, 'overBurn');
});
