// ============================================================================
// LunaCore - Life dashboard daily IPC (src/lifeipc.js): check-in, habits,
// weekly goals, productivity score
// ----------------------------------------------------------------------------
// Driven through a fake ipcMain against temp files; the ledger, GitHub, the
// to-do store and YAZIO are injected fakes. The renderer is untrusted: bad
// payloads must answer a fixed reason code, never throw.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerLifeIpc } = require('../src/lifeipc.js');

const H = 60 * 60 * 1000;
const NOW = new Date(2026, 9, 21, 15).getTime(); // Wednesday 2026-10-21, ISO 2026-W43

function harness({ ledger = null, github = null, todoStore = {}, yazio, clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lifedaily-ipc-'));
  const files = {
    checkin: path.join(dir, 'life-checkin.local.json'),
    habits: path.join(dir, 'life-habits.local.json'),
    goals: path.join(dir, 'life-goals.local.json'),
    score: path.join(dir, 'life-score.local.json'),
    series: path.join(dir, 'life-series.local.json'),
  };
  const handlers = new Map();
  let tick = 0;
  const now = clock || (() => NOW + 1000 * tick++);
  const fakeYazio = yazio || { status: () => ({ connected: false }), body: async () => null, connect: async () => ({}), disconnect: () => {} };
  registerLifeIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    file: path.join(dir, 'life-budget.local.json'),
    files,
    now,
    yazio: fakeYazio,
    cloud: () => null,
    bodyEveryMs: 0,
    ledger,
    github,
    readTodoStore: () => todoStore,
  });
  const call = (ch, arg) => handlers.get(ch)({}, arg);
  return { call, files };
}

// --- check-in -------------------------------------------------------------------

test('life:checkin: nothing yet, then set + read back with the last 14 days', async () => {
  const { call } = harness();
  let res = await call('life:checkin');
  assert.equal(res.ok, true);
  assert.equal(res.today, '2026-10-21');
  assert.equal(res.entry, null);
  assert.equal(res.days.length, 15);
  res = await call('life:checkin-set', { date: '2026-10-21', sleep: 7, energy: 4 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entry, { sleep: 7, energy: 4 });
  // Skip = both null, remembered for the day.
  res = await call('life:checkin-set', { date: '2026-10-20', sleep: null, energy: null });
  assert.equal(res.days[1].answered, true);
});

test('life:checkin-set refuses bad payloads with a reason code', async () => {
  const { call, files } = harness();
  for (const req of [null, 'x', {}, { date: '2026-10-21', sleep: 7.2, energy: 3 }, { date: '2026-10-21', sleep: 7, energy: 9 }, { date: '2030-01-01', sleep: 7, energy: 3 }, { date: { toString: () => 'x' }, sleep: 7, energy: 3 }]) {
    const res = await call('life:checkin-set', req);
    assert.equal(res.ok, false, JSON.stringify(req));
    assert.match(res.reason, /^[a-z-]+$/);
  }
  assert.equal(fs.existsSync(files.checkin), false);
});

test('life:checkin-set answers unreadable and leaves a broken file alone', async () => {
  const { call, files } = harness();
  fs.writeFileSync(files.checkin, '{broken');
  const res = await call('life:checkin-set', { date: '2026-10-21', sleep: 7, energy: 3 });
  assert.deepEqual(res, { ok: false, reason: 'unreadable' });
  assert.equal(fs.readFileSync(files.checkin, 'utf8'), '{broken');
});

// --- habits ---------------------------------------------------------------------

test('life:habits: the suggestions with status; tick and streak', async () => {
  const { call } = harness();
  let res = await call('life:habits');
  assert.equal(res.ok, true);
  assert.deepEqual(res.habits.map((h) => h.id), ['gym', 'steps', 'water', 'snacks']);
  assert.equal(res.habits[2].status.doneToday, false);
  await call('life:habits-do', { op: 'tick', data: { id: 'water', date: '2026-10-20', on: true } });
  res = await call('life:habits-do', { op: 'tick', data: { id: 'water', date: '2026-10-21', on: true } });
  const water = res.habits.find((h) => h.id === 'water');
  assert.equal(water.status.doneToday, true);
  assert.equal(water.status.streak, 2);
});

test('life:habits: the steps habit auto-ticks from YAZIO steps', async () => {
  const body = { date: '2026-10-21', today: { stepsGoal: 8000, kcal: 0, kcalGoal: 2000, protein: 0, proteinGoal: 0 }, history: [{ date: '2026-10-21', steps: 9100, kcal: 0, kcalGoal: 2000, protein: 0 }] };
  const yazio = { status: () => ({ connected: true }), body: async () => body };
  const { call } = harness({ yazio });
  const res = await call('life:habits');
  const steps = res.habits.find((h) => h.id === 'steps');
  assert.equal(steps.status.doneToday, true);
  assert.equal(steps.status.autoToday, true);
  assert.equal(res.steps, true);
});

test('life:habits-do refuses bad ops and payloads', async () => {
  const { call } = harness();
  for (const req of [null, {}, { op: 'nope', data: {} }, { op: 'tick' }, { op: 'tick', data: { id: 'water', date: '2026-10-01', on: true } }, { op: 'add', data: { name: 'a‮b', every: 'day' } }, { op: '__proto__', data: {} }]) {
    const res = await call('life:habits-do', req);
    assert.equal(res.ok, false, JSON.stringify(req));
    assert.match(res.reason, /^[a-z-]+$/);
  }
});

// --- goals ----------------------------------------------------------------------

test('life:goals: not asked yet, then set and mark status', async () => {
  const { call } = harness();
  let res = await call('life:goals');
  assert.equal(res.ok, true);
  assert.equal(res.week, '2026-W43');
  assert.equal(res.goals, null);
  res = await call('life:goals-set', { op: 'set', data: { week: '2026-W43', goals: ['Ship habits', 'Gym 3x'] } });
  assert.equal(res.goals.length, 2);
  res = await call('life:goals-set', { op: 'status', data: { week: '2026-W43', index: 0, status: 'partly' } });
  assert.equal(res.goals[0].status, 'partly');
});

test('life:goals-set refuses bad payloads', async () => {
  const { call } = harness();
  for (const req of [null, {}, { op: 'set', data: { week: '2026-W43', goals: ['a', 'b', 'c', 'd'] } }, { op: 'set', data: { week: 'nope', goals: [] } }, { op: 'status', data: { week: '2026-W43', index: 0, status: 'done' } }]) {
    const res = await call('life:goals-set', req);
    assert.equal(res.ok, false, JSON.stringify(req));
  }
});

// --- score ----------------------------------------------------------------------

function ledgerReport() {
  const days = Array.from({ length: 7 }, (_, i) => ({ start: new Date(2026, 9, 19 + i).getTime(), totalMs: i === 2 ? 3 * H : 0, switches: i === 2 ? 3 : 0 }));
  const prevDays = Array.from({ length: 7 }, (_, i) => ({ start: new Date(2026, 9, 12 + i).getTime(), totalMs: 0 }));
  return { ok: true, focus: { days, prevDays }, commitDays: null, now: { key: 'git:a', name: 'luna', sinceMs: NOW - H, lastMs: NOW - 60000 } };
}

test('life:score: re-weights over the parts with data, Now strip, arrows', async () => {
  const { call } = harness({ ledger: { report: async () => ledgerReport() } });
  const res = await call('life:score');
  assert.equal(res.ok, true);
  // Focus = 3 h of a 6 h target (0.5); health = the suggested daily habits,
  // none ticked (0); shipping and goals have no data and are left out.
  assert.equal(res.score.today.score, 25);
  assert.deepEqual(res.score.today.missing, ['shipping', 'goals']);
  assert.equal(res.score.yesterday.score, 0);
  assert.equal(res.score.dayTrend.dir, 'up');
  assert.equal(res.now.project.name, 'luna');
  assert.equal(res.now.switches, 3);
  assert.deepEqual(res.prefs.weights, { focus: 25, shipping: 25, goals: 25, health: 25 });
});

test('life:score survives every source failing (no data, not a crash)', async () => {
  const { call } = harness({
    ledger: { report: async () => Promise.reject(new Error('scan failed')) },
    github: { fetch: async () => Promise.reject(new Error('gh missing')) },
  });
  const res = await call('life:score');
  assert.equal(res.ok, true);
  assert.deepEqual(res.score.today.missing, ['focus', 'shipping', 'goals']);
  assert.equal(res.now.project, null);
  assert.equal(res.now.switches, null);
});

test('life:score-prefs saves normalised weights and the focus target', async () => {
  const { call } = harness({ ledger: { report: async () => ledgerReport() } });
  let res = await call('life:score-prefs', { weights: { focus: 100, shipping: 0, goals: 0, health: 0 }, focusTargetH: 3 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.prefs.weights, { focus: 100, shipping: 0, goals: 0, health: 0 });
  res = await call('life:score');
  assert.equal(res.score.today.score, 100);
  for (const bad of [null, {}, { weights: { focus: 0, shipping: 0, goals: 0, health: 0 }, focusTargetH: 6 }, { weights: { focus: 1, shipping: 1, goals: 1, health: 1 }, focusTargetH: 99 }]) {
    const r = await call('life:score-prefs', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('life:score shares one computation between calls close together; a write refreshes it', async () => {
  let reports = 0;
  const { call } = harness({ clock: () => NOW, ledger: { report: async () => { reports += 1; return ledgerReport(); } } });
  await Promise.all([call('life:score'), call('life:score'), call('life:score')]);
  await call('life:score');
  assert.equal(reports, 1);
  await call('life:checkin-set', { date: '2026-10-21', sleep: 8, energy: 5 });
  await call('life:score');
  assert.equal(reports, 2);
});

test('a bug inside life:score answers a fixed reason, not raw error text', async () => {
  const { call } = harness({ ledger: { report: async () => ({ ok: true, focus: { days: 'nope' }, commitDays: 5, now: null }) }, todoStore: { get p() { throw new Error('secret path C:/x'); } } });
  const res = await call('life:score');
  assert.equal(typeof res.ok, 'boolean');
  if (!res.ok) assert.equal(res.reason, 'failed');
});
