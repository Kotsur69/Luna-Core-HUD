// ============================================================================
// LunaCore - Life dashboard daily stores: check-in, habits, goals, score prefs
// ----------------------------------------------------------------------------
// src/lifecheckin.js, src/lifehabits.js, src/lifegoals.js, src/lifescoreprefs.js
// against temp files. Shared contract (src/lifestore.js): only ENOENT means
// "start fresh"; an unreadable file answers 'unreadable' and is never
// overwritten; writes are atomic.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checkin = require('../src/lifecheckin.js');
const habits = require('../src/lifehabits.js');
const goals = require('../src/lifegoals.js');
const prefs = require('../src/lifescoreprefs.js');

const NOW = new Date(2026, 9, 21, 12).getTime(); // Wednesday, 2026-W43
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lifedaily-')), name);

// --- check-in -------------------------------------------------------------------

test('check-in: a missing file is empty; a set day reads back', () => {
  const file = tmp('life-checkin.local.json');
  assert.deepEqual(checkin.loadCheckin(file), { v: 1, days: {} });
  checkin.setCheckin('2026-10-21', { sleep: 7.5, energy: 4 }, file, NOW);
  assert.deepEqual(checkin.loadCheckin(file).days['2026-10-21'], { sleep: 7.5, energy: 4 });
  // A skip is remembered as an answered day with no numbers.
  checkin.setCheckin('2026-10-20', { sleep: null, energy: null }, file, NOW);
  assert.deepEqual(checkin.loadCheckin(file).days['2026-10-20'], { sleep: null, energy: null });
});

test('check-in: values are validated (sleep 0-16 step 0.5, energy 1-5)', () => {
  const file = tmp('life-checkin.local.json');
  for (const bad of [{ sleep: 7.3, energy: 3 }, { sleep: 17, energy: 3 }, { sleep: -1, energy: 3 }, { sleep: 7, energy: 6 }, { sleep: 7, energy: 2.5 }, { sleep: '7', energy: 3 }, null]) {
    assert.throws(() => checkin.setCheckin('2026-10-21', bad, file, NOW), /bad value/, JSON.stringify(bad));
  }
  // Only today and the last 14 days can be edited.
  assert.throws(() => checkin.setCheckin('2026-10-22', { sleep: 7, energy: 3 }, file, NOW), /bad date/);
  assert.throws(() => checkin.setCheckin('2026-10-01', { sleep: 7, energy: 3 }, file, NOW), /bad date/);
  assert.equal(fs.existsSync(file), false);
});

test('check-in: keeps the newest 400 days; the view is today + last 14 days', () => {
  const file = tmp('life-checkin.local.json');
  const days = {};
  for (let i = 0; i < 420; i++) days[new Date(2025, 0, 1 + i).toLocaleDateString('sv-SE')] = { sleep: 8, energy: 3 };
  fs.writeFileSync(file, JSON.stringify({ v: 1, days }));
  checkin.setCheckin('2026-10-21', { sleep: 6, energy: 2 }, file, NOW);
  const store = checkin.loadCheckin(file);
  assert.equal(Object.keys(store.days).length, 400);
  assert.ok(store.days['2026-10-21']);
  const view = checkin.checkinView(store, NOW);
  assert.equal(view.today, '2026-10-21');
  assert.deepEqual(view.entry, { sleep: 6, energy: 2 });
  assert.equal(view.days.length, 15);
  assert.equal(view.days[0].date, '2026-10-21');
});

test('check-in: an unreadable file is refused and left alone', () => {
  const file = tmp('life-checkin.local.json');
  fs.writeFileSync(file, '{"v":1,"days":{');
  assert.throws(() => checkin.setCheckin('2026-10-21', { sleep: 7, energy: 3 }, file, NOW), /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1,"days":{');
  // Display never throws.
  assert.deepEqual(checkin.loadCheckin(file), { v: 1, days: {} });
});

// --- habits ---------------------------------------------------------------------

test('habits: a missing file starts with the four suggestions', () => {
  const store = habits.loadHabits(tmp('life-habits.local.json'));
  assert.deepEqual(store.habits.map((h) => h.id), ['gym', 'steps', 'water', 'snacks']);
  assert.equal(store.habits.find((h) => h.id === 'steps').auto, 'steps');
  assert.equal(store.habits.find((h) => h.id === 'gym').every, 'week');
});

test('habits: add, edit, tick today/yesterday, remove + restore', () => {
  const file = tmp('life-habits.local.json');
  let s = habits.applyHabits('add', { name: 'Czytanie', every: 'week', perWeek: 4 }, file, NOW);
  const added = s.habits[s.habits.length - 1];
  assert.equal(added.name, 'Czytanie');
  assert.match(added.id, /^[0-9a-f]{12}$/);
  s = habits.applyHabits('edit', { id: added.id, name: 'Ksiazka', every: 'day' }, file, NOW);
  assert.equal(s.habits.find((h) => h.id === added.id).every, 'day');
  s = habits.applyHabits('tick', { id: 'water', date: '2026-10-21', on: true }, file, NOW);
  s = habits.applyHabits('tick', { id: 'water', date: '2026-10-20', on: true }, file, NOW);
  assert.deepEqual(s.habits.find((h) => h.id === 'water').done, ['2026-10-20', '2026-10-21']);
  s = habits.applyHabits('tick', { id: 'water', date: '2026-10-21', on: false }, file, NOW);
  assert.deepEqual(s.habits.find((h) => h.id === 'water').done, ['2026-10-20']);
  // Older days cannot be ticked.
  assert.throws(() => habits.applyHabits('tick', { id: 'water', date: '2026-10-19', on: true }, file, NOW), /bad date/);
  const before = s.habits.find((h) => h.id === 'water');
  s = habits.applyHabits('remove', { id: 'water' }, file, NOW);
  assert.equal(s.habits.some((h) => h.id === 'water'), false);
  s = habits.applyHabits('restore', { habit: before, index: 2 }, file, NOW);
  assert.deepEqual(s.habits[2], before);
});

test('habits: names are capped and bidi / zero-width text is refused', () => {
  const file = tmp('life-habits.local.json');
  for (const name of ['', '   ', 'x'.repeat(41), 'gym‮', 'a​b', 'a\nb', 42]) {
    assert.throws(() => habits.applyHabits('add', { name, every: 'day' }, file, NOW), /bad text/, JSON.stringify(name));
  }
  assert.throws(() => habits.applyHabits('add', { name: 'ok', every: 'month' }, file, NOW), /bad value/);
  assert.throws(() => habits.applyHabits('add', { name: 'ok', every: 'week', perWeek: 8 }, file, NOW), /bad value/);
  assert.throws(() => habits.applyHabits('nope', {}, file, NOW), /bad op/);
  assert.throws(() => habits.applyHabits('constructor', {}, file, NOW), /bad op/);
});

test('habits: at most 30', () => {
  const file = tmp('life-habits.local.json');
  for (let i = 0; i < 26; i++) habits.applyHabits('add', { name: `h${i}`, every: 'day' }, file, NOW);
  assert.throws(() => habits.applyHabits('add', { name: 'one more', every: 'day' }, file, NOW), /too many/);
});

test('habits: a hand-edited file keeps only valid rows and days', () => {
  const file = tmp('life-habits.local.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, habits: [{ id: 'gym', name: '', every: 'week', perWeek: 3, auto: '', done: ['2026-10-20', 'junk', '2026-10-20'] }, { id: 'BAD ID' }, null] }));
  const store = habits.loadHabits(file);
  assert.equal(store.habits.length, 1);
  assert.deepEqual(store.habits[0].done, ['2026-10-20']);
});

// --- goals ----------------------------------------------------------------------

test('goals: set up to 3 for an ISO week, then mark status', () => {
  const file = tmp('life-goals.local.json');
  let s = goals.applyGoals('set', { week: '2026-W43', goals: ['Ship check-in', ' Gym 3x '] }, file, NOW);
  assert.deepEqual(s.weeks['2026-W43'].map((g) => [g.text, g.status]), [['Ship check-in', 'notyet'], ['Gym 3x', 'notyet']]);
  s = goals.applyGoals('status', { week: '2026-W43', index: 1, status: 'done' }, file, NOW);
  assert.equal(s.weeks['2026-W43'][1].status, 'done');
  // Re-setting keeps the status of goals whose text did not change.
  s = goals.applyGoals('set', { week: '2026-W43', goals: ['Ship check-in', 'Gym 3x', 'Read'] }, file, NOW);
  assert.equal(s.weeks['2026-W43'][1].status, 'done');
  // An empty list = the week was asked and skipped.
  s = goals.applyGoals('set', { week: '2026-W42', goals: [] }, file, NOW);
  assert.deepEqual(s.weeks['2026-W42'], []);
});

test('goals: validation (1-140 chars, max 3, week near now, fixed statuses)', () => {
  const file = tmp('life-goals.local.json');
  const bad = [
    ['set', { week: '2026-W43', goals: ['a', 'b', 'c', 'd'] }, /too many/],
    ['set', { week: '2026-W43', goals: ['x'.repeat(141)] }, /bad text/],
    ['set', { week: '2026-W43', goals: [''] }, /bad text/],
    ['set', { week: '2026-W43', goals: 'a' }, /bad value/],
    ['set', { week: '2026-W50', goals: ['a'] }, /bad week/],
    ['set', { week: '2026-W43x', goals: ['a'] }, /bad week/],
    ['status', { week: '2026-W43', index: 0, status: 'done' }, /not found/],
  ];
  for (const [op, data, re] of bad) assert.throws(() => goals.applyGoals(op, data, file, NOW), re, JSON.stringify(data));
  goals.applyGoals('set', { week: '2026-W43', goals: ['a'] }, file, NOW);
  assert.throws(() => goals.applyGoals('status', { week: '2026-W43', index: 0, status: 'maybe' }, file, NOW), /bad value/);
});

test('goals: keeps the last 52 weeks; view = this week + last week', () => {
  const file = tmp('life-goals.local.json');
  const weeks = {};
  for (let w = 1; w <= 53; w++) weeks[`2025-W${String(w).padStart(2, '0')}`] = [{ text: 'old', status: 'done' }];
  fs.writeFileSync(file, JSON.stringify({ v: 1, weeks }));
  goals.applyGoals('set', { week: '2026-W43', goals: ['now'] }, file, NOW);
  const store = goals.loadGoals(file);
  assert.equal(Object.keys(store.weeks).length, 52);
  assert.ok(store.weeks['2026-W43']);
  const view = goals.goalsView(store, NOW);
  assert.equal(view.week, '2026-W43');
  assert.equal(view.goals[0].text, 'now');
  assert.equal(view.lastWeek, '2026-W42');
  assert.equal(view.last, null);
});

// --- score prefs ----------------------------------------------------------------

test('score prefs: defaults 25 each + 6 h; weights normalise to 100', () => {
  const file = tmp('life-score.local.json');
  assert.deepEqual(prefs.loadScorePrefs(file), { v: 1, weights: { focus: 25, shipping: 25, goals: 25, health: 25 }, focusTargetH: 6 });
  const s = prefs.setScorePrefs({ weights: { focus: 50, shipping: 50, goals: 0, health: 100 }, focusTargetH: 4.5 }, file);
  assert.deepEqual(s.weights, { focus: 25, shipping: 25, goals: 0, health: 50 });
  assert.equal(s.focusTargetH, 4.5);
  assert.throws(() => prefs.setScorePrefs({ weights: { focus: 0, shipping: 0, goals: 0, health: 0 }, focusTargetH: 6 }, file), /bad value/);
  assert.throws(() => prefs.setScorePrefs({ weights: { focus: -1, shipping: 0, goals: 0, health: 1 }, focusTargetH: 6 }, file), /bad value/);
  assert.throws(() => prefs.setScorePrefs({ weights: { focus: 1, shipping: 1, goals: 1, health: 1 }, focusTargetH: 20 }, file), /bad value/);
});

test('habits: invisible fillers, Arabic letter mark and lone surrogates are refused', () => {
  const file = tmp('life-habits.local.json');
  for (const name of ['\u3164', 'a\u061cb', 'a\u2060b', 'a\u00adb', 'x\ud800']) {
    assert.throws(() => habits.applyHabits('add', { name, every: 'day' }, file, NOW), /bad text/, JSON.stringify(name));
  }
});

test('habits: restore cannot grant auto-tick to a habit that is not the built-in steps one', () => {
  const file = tmp('life-habits.local.json');
  const s = habits.applyHabits('restore', { habit: { id: 'abc123', name: 'Mine', every: 'day', perWeek: 7, auto: 'steps', done: [] }, index: 0 }, file, NOW);
  assert.equal(s.habits[0].auto, '');
});
