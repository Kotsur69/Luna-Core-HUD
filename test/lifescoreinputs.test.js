// ============================================================================
// LunaCore - Life score inputs (src/lifescoreinputs.js, pure)
// ----------------------------------------------------------------------------
// Turns the raw sources (ledger report, GitHub, to-dos, YAZIO, check-in,
// habits, goals) into per-day score inputs. A source that is missing gives
// null fields, never zeros.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dayInputs, autoDays, goalsByWeek, nowStrip, kcalProgress, proteinProgress } = require('../src/lifescoreinputs.js');

const H = 60 * 60 * 1000;
const TODAY = '2026-10-21';
const at = (day, h = 12) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, h).getTime();
};
const NOW = at(TODAY, 15);

function report() {
  const days = Array.from({ length: 7 }, (_, i) => ({ start: new Date(2026, 9, 19 + i).getTime(), totalMs: 0, switches: 0 }));
  days[2] = { ...days[2], totalMs: 3 * H, switches: 4 };
  const prevDays = Array.from({ length: 7 }, (_, i) => ({ start: new Date(2026, 9, 12 + i).getTime(), totalMs: i === 2 ? 2 * H : 0 }));
  const commitDays = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(2026, 9, 8 + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date, commits: date === TODAY ? 3 : 0, feat: date === TODAY ? 1 : 0, fix: 0 };
  });
  return { focus: { days, prevDays }, commitDays, now: { key: 'git:a', name: 'a', sinceMs: NOW - H, lastMs: NOW - 60000 } };
}

const base = { today: TODAY, nowMs: NOW, report: null, github: null, todoStore: {}, body: null, checkin: { days: {} }, habits: [] };

test('with no sources every field is null (no data, not zero)', () => {
  const days = dayInputs(base);
  assert.equal(Object.keys(days).length, 14);
  assert.deepEqual(days[TODAY], { focusMs: null, commits: null, feat: 0, fix: 0, prs: null, todos: null, kcalHit: null, proteinHit: null, sleep: null, habits: null });
});

test('focus and commits come from the ledger report (this week + last week)', () => {
  const days = dayInputs({ ...base, report: report() });
  assert.equal(days[TODAY].focusMs, 3 * H);
  assert.equal(days['2026-10-14'].focusMs, 2 * H);
  assert.equal(days['2026-10-20'].focusMs, 0);
  assert.equal(days[TODAY].commits, 3);
  assert.equal(days[TODAY].feat, 1);
  assert.equal(days['2026-10-20'].commits, 0);
  // Days after today are not in the week so far: no focus number for them.
  assert.equal(days['2026-10-22'], undefined);
});

test('PRs count my open PRs updated that day; to-dos count doneAt per day', () => {
  const github = { lists: { prs: { items: [{ updatedAt: new Date(at(TODAY, 10)).toISOString() }, { updatedAt: new Date(at('2026-10-20', 10)).toISOString() }, { updatedAt: 'junk' }] } } };
  const todoStore = { p1: [{ text: 'a', done: true, at: 1, doneAt: at(TODAY, 9) }, { text: 'b', done: true, at: 2, doneAt: at(TODAY, 11) }], p2: [{ text: 'c', done: false, at: 3 }] };
  const days = dayInputs({ ...base, github, todoStore });
  assert.equal(days[TODAY].prs, 1);
  assert.equal(days['2026-10-20'].prs, 1);
  assert.equal(days['2026-10-19'].prs, 0);
  assert.equal(days[TODAY].todos, 2);
  assert.equal(days['2026-10-20'].todos, 0);
  assert.equal(dayInputs({ ...base, todoStore: { p: [] } })[TODAY].todos, null);
});

test('health: YAZIO history, today as progress, check-in sleep, daily habits', () => {
  const body = {
    date: TODAY,
    today: { kcal: 1100, kcalGoal: 2200, protein: 75, proteinGoal: 150, steps: 9000, stepsGoal: 8000 },
    history: [
      { date: '2026-10-20', kcal: 2100, kcalGoal: 2200, protein: 140, steps: 4000 },
      { date: TODAY, kcal: 1100, kcalGoal: 2200, protein: 75, steps: 9000 },
    ],
  };
  const checkin = { days: { [TODAY]: { sleep: 7.5, energy: 4 }, '2026-10-20': { sleep: null, energy: null } } };
  const habits = [{ id: 'steps', every: 'day', perWeek: 7, auto: 'steps', done: [] }, { id: 'water', every: 'day', perWeek: 7, auto: '', done: ['2026-10-20'] }];
  const days = dayInputs({ ...base, body, checkin, habits });
  assert.equal(days['2026-10-20'].kcalHit, true);
  assert.equal(days['2026-10-20'].proteinHit, true);
  // Mid-day today: progress toward the goals, not a hit/miss yet.
  assert.equal(days[TODAY].kcalHit, 0.5);
  assert.equal(days[TODAY].proteinHit, 75 / 135);
  assert.equal(days[TODAY].sleep, 7.5);
  assert.equal(days['2026-10-20'].sleep, null);
  assert.deepEqual(days[TODAY].habits, { done: 1, due: 2 });
  assert.deepEqual(days['2026-10-20'].habits, { done: 1, due: 2 });
});

test('kcal / protein progress: capped, and over 115% of kcal is a miss', () => {
  assert.equal(kcalProgress(2200, 2200), 1);
  assert.equal(kcalProgress(2600, 2200), 0);
  assert.equal(kcalProgress(0, 2200), null);
  assert.equal(proteinProgress(200, 150), 1);
  assert.equal(proteinProgress(10, 0), null);
});

test('autoDays: days YAZIO steps reached today\'s steps goal', () => {
  const body = { today: { stepsGoal: 8000 }, history: [{ date: '2026-10-20', steps: 8000 }, { date: TODAY, steps: 100 }] };
  assert.deepEqual([...autoDays(body).steps], ['2026-10-20']);
  assert.deepEqual([...autoDays(null).steps], []);
  assert.deepEqual([...autoDays({ today: { stepsGoal: 0 }, history: [{ date: TODAY, steps: 9 }] }).steps], []);
});

test('goalsByWeek: done 1, partly 0.5; empty / skipped weeks are null', () => {
  const g = goalsByWeek({ weeks: { '2026-W43': [{ text: 'a', status: 'done' }, { text: 'b', status: 'partly' }], '2026-W42': [] } });
  assert.deepEqual(g, { '2026-W43': 0.75, '2026-W42': null });
});

test('nowStrip: the live project, time in it, and today\'s switch count', () => {
  const s = nowStrip(report(), TODAY, NOW);
  assert.deepEqual(s, { project: { key: 'git:a', name: 'a', sinceMs: NOW - H, lastMs: NOW - 60000 }, inMs: H, switches: 4 });
  assert.deepEqual(nowStrip(null, TODAY, NOW), { project: null, inMs: 0, switches: null });
});
