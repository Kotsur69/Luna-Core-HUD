// ============================================================================
// LunaCore - Mission Control focus view math (renderer/modules/missionfocusview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { focusView, focusLevel, FOCUS_TOP } = require('../src/renderer/modules/missionfocusview.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MON = new Date(2026, 9, 12).getTime();
const dayStart = (i) => new Date(2026, 9, 12 + i).getTime();
const NOW = new Date(2026, 9, 13, 15).getTime(); // Tuesday afternoon

function focus(projects, days = {}) {
  return {
    weekStart: MON,
    totalMs: projects.reduce((s, p) => s + p.totalMs, 0),
    days: Array.from({ length: 7 }, (_, i) => ({ start: dayStart(i), totalMs: 0, switches: 0, ...(days[i] || {}) })),
    projects,
    moreProjects: 0,
  };
}
const p = (key, hours, cls = null) => ({ key, name: key.split(/[:/]/).pop(), cls, totalMs: hours[0] * HOUR + (hours[1] || 0) * HOUR, days: [hours[0] * HOUR, (hours[1] || 0) * HOUR, 0, 0, 0, 0, 0] });

test('focusLevel buckets minutes into 0-4 like the GitHub heatmap', () => {
  assert.deepEqual([0, 5 * MIN, 30 * MIN, HOUR, 2 * HOUR, 6 * HOUR].map(focusLevel), [0, 1, 2, 3, 4, 4]);
});

test('rows are the top projects with a heat level per day; the rest are summed', () => {
  const many = Array.from({ length: FOCUS_TOP + 2 }, (_, i) => p(`git:p${i}`, [10 - i]));
  const v = focusView(focus(many), NOW);
  assert.equal(v.rows.length, FOCUS_TOP);
  assert.equal(v.restCount, 2);
  assert.equal(v.restMs, (10 - FOCUS_TOP + 10 - FOCUS_TOP - 1) * HOUR);
  assert.deepEqual(v.rows[0].cells.slice(0, 2).map((c) => c.level), [4, 0]);
});

test('classes: "other" is other, a repo without a class is unassigned', () => {
  const v = focusView(focus([p('git:a', [1], 'work'), p('other', [1]), p('git:b', [1])]), NOW);
  assert.deepEqual(v.rows.map((r) => r.cls), ['work', 'other', 'unassigned']);
});

test('days after today are marked future; today is flagged', () => {
  const v = focusView(focus([p('git:a', [1, 2])], { 1: { totalMs: 2 * HOUR, switches: 3 } }), NOW);
  assert.deepEqual(v.days.map((d) => d.isFuture), [false, false, true, true, true, true, true]);
  assert.equal(v.days[1].isToday, true);
  assert.deepEqual(v.today, { totalMs: 2 * HOUR, switches: 3 });
  assert.ok(v.rows[0].cells[3].isFuture);
});

test('no report or no focus is null; an empty week has no rows', () => {
  assert.equal(focusView(null, NOW), null);
  assert.equal(focusView(undefined, NOW), null);
  const v = focusView(focus([]), NOW);
  assert.deepEqual(v.rows, []);
  assert.equal(v.totalMs, 0);
});

test('rows carry a share of the busiest project and today marks on cells', () => {
  const day = 24 * 3600 * 1000;
  const start = Date.UTC(2026, 9, 12);
  const days = Array.from({ length: 7 }, (_, i) => ({ start: start + i * day, totalMs: 0, switches: 0 }));
  const v = focusView(
    {
      totalMs: 3 * 3600000,
      days,
      projects: [
        { key: 'git:a', name: 'a', totalMs: 2 * 3600000, days: [0, 2 * 3600000, 0, 0, 0, 0, 0] },
        { key: 'git:b', name: 'b', totalMs: 3600000, days: [3600000, 0, 0, 0, 0, 0, 0] },
      ],
    },
    start + day + 3600000
  );
  assert.deepEqual(v.rows.map((r) => r.share), [1, 0.5]);
  assert.deepEqual(v.rows[0].cells.map((c) => c.isToday), [false, true, false, false, false, false, false]);
});
