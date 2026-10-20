// ============================================================================
// LunaCore - live productivity score (src/lifescore.js, pure)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { partValues, scoreOf, scoreReport, kcalHit, proteinHit, SHIP_POINTS_PER_DAY } = require('../src/lifescore.js');

const H = 60 * 60 * 1000;
const W25 = { focus: 25, shipping: 25, goals: 25, health: 25 };
const empty = { focusMs: null, commits: null, feat: 0, fix: 0, prs: null, todos: null, kcalHit: null, proteinHit: null, sleep: null, habits: null };

test('focus = hours vs the daily target, capped at 1', () => {
  assert.equal(partValues({ ...empty, focusMs: 3 * H }, { focusTargetH: 6 }).focus, 0.5);
  assert.equal(partValues({ ...empty, focusMs: 9 * H }, { focusTargetH: 6 }).focus, 1);
  // Over a week the target scales with the days counted.
  assert.equal(partValues({ ...empty, focusMs: 6 * H }, { focusTargetH: 6, days: 2 }).focus, 0.5);
  assert.equal(partValues(empty, { focusTargetH: 6 }).focus, null);
});

test('shipping: commits + feat/fix + PRs as points vs a daily target', () => {
  const v = partValues({ ...empty, commits: 2, feat: 1, fix: 0, prs: 0 }, { focusTargetH: 6 }).shipping;
  assert.equal(v, 3 / SHIP_POINTS_PER_DAY);
  assert.equal(partValues({ ...empty, commits: 0, prs: 0 }, { focusTargetH: 6 }).shipping, 0);
  assert.equal(partValues({ ...empty, commits: 20, prs: 1 }, { focusTargetH: 6 }).shipping, 1);
});

test('goals: the week fraction and closed to-dos, averaged over what exists', () => {
  assert.equal(partValues({ ...empty, todos: 3 }, { focusTargetH: 6, goals: 0.5 }).goals, (0.5 + 1) / 2);
  assert.equal(partValues({ ...empty }, { focusTargetH: 6, goals: 0.5 }).goals, 0.5);
  assert.equal(partValues(empty, { focusTargetH: 6, goals: null }).goals, null);
});

test('health: kcal / protein hit, sleep, habits; parts with no data drop out', () => {
  const v = partValues({ ...empty, kcalHit: true, proteinHit: false, sleep: 7.5, habits: { done: 1, due: 2 } }, { focusTargetH: 6 }).health;
  assert.equal(v, (1 + 0 + 1 + 0.5) / 4);
  assert.equal(partValues({ ...empty, sleep: 3.75 }, { focusTargetH: 6 }).health, 0.5);
  assert.equal(partValues(empty, { focusTargetH: 6 }).health, null);
});

test('kcal hit = within 15% of the goal; protein hit = 90% of the goal', () => {
  assert.equal(kcalHit(2000, 2200), true);
  assert.equal(kcalHit(2600, 2200), false);
  assert.equal(kcalHit(0, 2200), null);
  assert.equal(kcalHit(2000, 0), null);
  assert.equal(proteinHit(135, 150), true);
  assert.equal(proteinHit(100, 150), false);
  assert.equal(proteinHit(100, 0), null);
});

test('scoreOf re-weights over the parts that have data and says which are missing', () => {
  const s = scoreOf({ focus: 1, shipping: 0.5, goals: null, health: null }, W25);
  assert.equal(s.score, 75);
  assert.deepEqual(s.missing, ['goals', 'health']);
  assert.deepEqual(s.parts.map((p) => [p.key, p.share]), [['focus', 50], ['shipping', 50], ['goals', 0], ['health', 0]]);
  const w = scoreOf({ focus: 1, shipping: 0, goals: 0, health: 0 }, { focus: 70, shipping: 10, goals: 10, health: 10 });
  assert.equal(w.score, 70);
  assert.equal(scoreOf({ focus: null, shipping: null, goals: null, health: null }, W25).score, null);
  // A part weighted 0 is not "missing", just not counted.
  assert.deepEqual(scoreOf({ focus: 1, shipping: null, goals: null, health: null }, { focus: 0, shipping: 50, goals: 50, health: 0 }).score, null);
});

test('scoreReport: today vs yesterday and week vs last week, with arrows', () => {
  const days = {
    '2026-10-20': { ...empty, focusMs: 3 * H, commits: 0, prs: 0 }, // Tuesday
    '2026-10-21': { ...empty, focusMs: 6 * H, commits: 4, prs: 0 }, // Wednesday (today)
    '2026-10-14': { ...empty, focusMs: 6 * H, commits: 4, prs: 0 },
  };
  const r = scoreReport({ days, today: '2026-10-21', goalsByWeek: {}, weights: W25, focusTargetH: 6 });
  assert.equal(r.today.score, 100);
  assert.equal(r.yesterday.score, 25);
  assert.deepEqual(r.dayTrend, { dir: 'up', delta: 75 });
  // This week so far = Mon-Wed (3 days); last week = 7 days.
  assert.equal(r.week.days, 3);
  assert.equal(r.lastWeek.days, 7);
  assert.equal(r.weekTrend.dir, 'up');
  assert.equal(scoreReport({ days: {}, today: '2026-10-21', goalsByWeek: {}, weights: W25, focusTargetH: 6 }).dayTrend, null);
});

test('scoreReport uses each day\'s own ISO week goals (Monday looks back at last week)', () => {
  const r = scoreReport({ days: {}, today: '2026-10-19', goalsByWeek: { '2026-W43': 1, '2026-W42': 0 }, weights: W25, focusTargetH: 6 });
  assert.equal(r.today.score, 100);
  assert.equal(r.yesterday.score, 0);
});
