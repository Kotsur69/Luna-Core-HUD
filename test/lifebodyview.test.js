// ============================================================================
// LunaCore - Life dashboard Body tab math (renderer/modules/lifebodyview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { kcalState, goalShare, weightProgress, weekStats } = require('../src/renderer/modules/lifebodyview.js');

test('kcalState: left to eat, near the goal, over it', () => {
  assert.deepEqual(kcalState(1450, 2200), { left: 750, share: 1450 / 2200, status: 'under' });
  assert.equal(kcalState(2100, 2200).status, 'near');
  assert.equal(kcalState(2200, 2200).status, 'near');
  assert.deepEqual(kcalState(2500, 2200), { left: -300, share: 2500 / 2200, status: 'over' });
});

test('kcalState: no goal means no share and no judgement', () => {
  assert.deepEqual(kcalState(900, 0), { left: 0, share: 0, status: 'none' });
});

test('goalShare: 0..n against a goal, hit at or past it', () => {
  assert.deepEqual(goalShare(81, 150), { share: 0.54, hit: false });
  assert.deepEqual(goalShare(10400, 10000), { share: 1.04, hit: true });
  assert.deepEqual(goalShare(5, 0), { share: 0, hit: false });
});

test('weightProgress works for losing and for gaining', () => {
  assert.deepEqual(weightProgress(90, 84.2, 80), { share: 0.58, toGo: 4.2, changed: -5.8 });
  assert.deepEqual(weightProgress(60, 63, 66), { share: 0.5, toGo: 3, changed: 3 });
});

test('weightProgress clamps past the goal and needs all three numbers', () => {
  assert.equal(weightProgress(90, 79, 80).share, 1);
  assert.equal(weightProgress(90, 92, 80).share, 0);
  assert.equal(weightProgress(null, 84, 80), null);
  assert.equal(weightProgress(90, 84, null), null);
  assert.equal(weightProgress(80, 80, 80), null);
});

test('weekStats averages only the days with something logged', () => {
  const history = [
    { date: '2026-10-08', kcal: 0, kcalGoal: 2200, protein: 0, steps: 3000 },
    { date: '2026-10-09', kcal: 2000, kcalGoal: 2200, protein: 150, steps: 9000 },
    { date: '2026-10-10', kcal: 2600, kcalGoal: 2200, protein: 100, steps: 12000 },
    { date: '2026-10-11', kcal: 1800, kcalGoal: 2200, protein: 155, steps: 6000 },
  ];
  assert.deepEqual(weekStats(history, 150), {
    logged: 3,
    avgKcal: 2133,
    onTarget: 2,
    proteinHit: 2,
    avgSteps: 7500,
  });
});

test('weekStats on an empty week is all zeros', () => {
  assert.deepEqual(weekStats([], 150), { logged: 0, avgKcal: 0, onTarget: 0, proteinHit: 0, avgSteps: 0 });
});
