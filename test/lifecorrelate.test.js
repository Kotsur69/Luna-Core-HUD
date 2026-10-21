// ============================================================================
// LunaCore - local correlations (src/lifecorrelate.js) + the series store
// (src/lifeseries.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { correlate, topCorrelations, phrase, seriesFromInputs, MIN_DAYS } = require('../src/lifecorrelate.js');
const { loadSeries, recordSeries } = require('../src/lifeseries.js');

const H = 60 * 60 * 1000;

/** n days; `fn(i)` gives the row for day i. */
function series(n, fn) {
  const out = {};
  for (let i = 0; i < n; i++) out[`2026-09-${String(i + 1).padStart(2, '0')}`] = fn(i);
  return out;
}

test('protein-goal days with clearly more focus are reported, with group sizes', () => {
  const s = series(20, (i) => ({ proteinHit: i % 2 === 0, focusH: i % 2 === 0 ? 6 : 3 }));
  const found = correlate(s);
  const c = found.find((x) => x.outcome === 'focusH' && x.condition === 'proteinHit');
  assert.ok(c);
  assert.equal(c.withMean, 6);
  assert.equal(c.withoutMean, 3);
  assert.equal(c.nWith, 10);
  assert.equal(c.nWithout, 10);
  assert.match(phrase(c), /^On days when you hit your protein goal, on average you had 6\.0 h of focus vs 3\.0 h/);
});

test('nothing is reported below 14 days or 5 days per group', () => {
  assert.deepEqual(correlate(series(MIN_DAYS - 1, (i) => ({ proteinHit: i % 2 === 0, focusH: i % 2 ? 1 : 8 }))), []);
  // 20 days but only 4 with the condition.
  assert.deepEqual(correlate(series(20, (i) => ({ proteinHit: i < 4, focusH: i < 4 ? 9 : 2 }))), []);
});

test('a small effect stays below the threshold', () => {
  const s = series(20, (i) => ({ sleep: i % 2 ? 8 : 6, focusH: i % 2 ? 5.2 : 5 }));
  assert.deepEqual(correlate(s), []);
});

test('unknown values do not count as a group', () => {
  const s = series(20, () => ({ proteinHit: null, focusH: 5 }));
  assert.deepEqual(correlate(s), []);
});

test('top 3, strongest first', () => {
  const s = series(30, (i) => {
    const a = i % 2 === 0;
    return { proteinHit: a, kcalHit: a, sleep: a ? 8 : 5, energy: a ? 5 : 2, habits: a ? 1 : 0.5, focusH: a ? 6 : 2, score: a ? 80 : 40, commits: a ? 6 : 1 };
  });
  const top = topCorrelations(s);
  assert.equal(top.length, 3);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].rel >= top[i].rel);
});

test('seriesFromInputs keeps finished days only, with check-in and a day score', () => {
  const days = {
    '2026-10-19': { focusMs: 4 * H, commits: 3, feat: 1, fix: 0, prs: 0, todos: 1, kcalHit: true, proteinHit: false, sleep: 7, habits: { done: 2, due: 4 } },
    '2026-10-20': { focusMs: 1 * H, commits: 0, feat: 0, fix: 0, prs: 0, todos: 0, kcalHit: 0.5, proteinHit: 0.4, sleep: null, habits: null },
  };
  const out = seriesFromInputs({ days, today: '2026-10-20', checkin: { days: { '2026-10-19': { sleep: 7, energy: 4 } } }, goalsByWeek: {}, weights: { focus: 25, shipping: 25, goals: 25, health: 25 }, focusTargetH: 6 });
  assert.deepEqual(Object.keys(out), ['2026-10-19']);
  const d = out['2026-10-19'];
  assert.equal(d.focusH, 4);
  assert.equal(d.energy, 4);
  assert.equal(d.proteinHit, false);
  assert.equal(d.habits, 0.5);
  assert.equal(typeof d.score, 'number');
});

test('the series store writes only when something changed and drops bad rows', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-series-')), 'life-series.local.json');
  const row = { focusH: 3, score: 50, commits: 2, proteinHit: true, kcalHit: null, sleep: 7, energy: 4, habits: 1 };
  assert.equal(recordSeries({ '2026-10-19': row, 'not-a-day': row }, file), true);
  assert.equal(recordSeries({ '2026-10-19': row }, file), false);
  assert.deepEqual(Object.keys(loadSeries(file).days), ['2026-10-19']);
  assert.equal(recordSeries({ '2026-10-19': { ...row, focusH: 999 } }, file), true);
  assert.equal(loadSeries(file).days['2026-10-19'].focusH, null);
});
