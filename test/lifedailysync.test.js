// ============================================================================
// LunaCore - Life daily stores sync between PCs (src/lifedailysync.js)
// ----------------------------------------------------------------------------
// Check-in, habits, weekly goals and score settings ride the cloud's `config`
// scope as configsync providers. Two simulated PCs share a fake cloud with the
// server's newest-wins rule; rows go through the real cloudrows mapping. A
// check-in answered on one PC must stop the other one asking; a fresh PC or a
// broken file must never wipe real data.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigSync } = require('../src/configsync.js');
const { lifeProviders, lifeParts, CHECKIN, HABITS, GOALS, SCORE } = require('../src/lifedailysync.js');
const checkin = require('../src/lifecheckin.js');
const habits = require('../src/lifehabits.js');
const goals = require('../src/lifegoals.js');
const scorePrefs = require('../src/lifescoreprefs.js');
const { ymd, addDays, isoWeek } = require('../src/lifedays.js');
const rows = require('../src/cloudrows.js');

/** sync_units for one scope: newest `u` wins per key, like push_units. */
function fakeCloud() {
  const mirror = {};
  return {
    mirror,
    peers: () => [rows.lifePeer(mirror)],
    publish(doc) {
      for (const x of rows.lifeUnits(doc)) {
        if (mirror[x.k] && !(x.u > mirror[x.k].u)) continue;
        mirror[x.k] = { v: x.v, u: x.u, d: x.d };
      }
    },
  };
}

function pc(cloud, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lifedaily-'));
  const files = {
    checkin: path.join(dir, 'life-checkin.local.json'),
    habits: path.join(dir, 'life-habits.local.json'),
    goals: path.join(dir, 'life-goals.local.json'),
    score: path.join(dir, 'life-score.local.json'),
  };
  const sync = createConfigSync({
    providers: lifeProviders(files),
    metaFile: path.join(dir, 'config-sync.local.json'),
    now: () => clock.t,
    extraPeers: () => cloud.peers(),
    onPublish: (doc) => cloud.publish(doc),
  });
  return {
    files,
    sync: () => lifeParts(sync.syncOnce()),
    today: () => ymd(clock.t),
    setCheckin: (date, entry) => checkin.setCheckin(date, entry, files.checkin, clock.t),
    checkinView: () => checkin.checkinView(checkin.loadCheckin(files.checkin), clock.t),
    habit: (op, data) => habits.applyHabits(op, data, files.habits, clock.t),
    habits: () => habits.loadHabits(files.habits).habits,
    goal: (op, data) => goals.applyGoals(op, data, files.goals, clock.t),
    goals: () => goals.loadGoals(files.goals),
    setScore: (data) => scorePrefs.setScorePrefs(data, files.score),
    score: () => scorePrefs.loadScorePrefs(files.score),
  };
}

function setup() {
  const cloud = fakeCloud();
  // Real time, so a first sync's mtime stamps sit in the same range as the clock.
  const clock = { t: Date.now() };
  return { cloud, clock, a: pc(cloud, clock), b: pc(cloud, clock) };
}

const tick = (clock) => (clock.t += 1000);
const WEIGHTS = { focus: 40, shipping: 30, goals: 20, health: 10 };

// --- units ----------------------------------------------------------------------

test('units round-trip every store unchanged', () => {
  const { a } = setup();
  a.setCheckin(a.today(), { sleep: 7.5, energy: 4 });
  a.setCheckin(addDays(a.today(), -1), { sleep: null, energy: null });
  a.habit('add', { name: 'Read', every: 'week', perWeek: 2 });
  a.habit('tick', { id: 'water', date: a.today(), on: true });
  a.habit('tick', { id: 'water', date: addDays(a.today(), -1), on: true });
  a.goal('set', { week: isoWeek(a.today()), goals: ['Ship sync', 'Gym x3'] });
  a.goal('status', { week: isoWeek(a.today()), index: 1, status: 'partly' });
  a.setScore({ weights: WEIGHTS, focusTargetH: 5 });

  const pairs = [
    [CHECKIN, checkin.loadCheckin(a.files.checkin)],
    [HABITS, habits.loadHabits(a.files.habits)],
    [GOALS, a.goals()],
    [SCORE, a.score()],
  ];
  for (const [spec, data] of pairs) {
    const units = spec.toUnits(data);
    assert.ok(units.length > 0, spec.name);
    assert.deepEqual(spec.fromUnits(units), data, spec.name);
    // Every unit a PC publishes passes its own peer check.
    for (const [k, v] of units) assert.deepEqual(spec.valid(k, v), v, `${spec.name} ${k}`);
  }
  const keys = HABITS.toUnits(habits.loadHabits(a.files.habits)).map(([k]) => k);
  assert.ok(keys.includes('life:hb:water'));
  assert.ok(keys.includes(`life:ht:water:${a.today()}`));
});

// --- check-in -----------------------------------------------------------------------

test('a check-in answered on PC A stops PC B asking after a sync', () => {
  const { a, b, clock } = setup();
  assert.equal(b.checkinView().entry, null);
  a.setCheckin(a.today(), { sleep: 8, energy: 5 });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['checkin']);
  assert.deepEqual(b.checkinView().entry, { sleep: 8, energy: 5 });
  // Nothing new: a second round changes nothing.
  tick(clock);
  assert.deepEqual(b.sync(), []);
});

test('a skipped check-in (both null) syncs too, so the other PC does not ask', () => {
  const { a, b, clock } = setup();
  a.setCheckin(a.today(), { sleep: null, energy: null });
  a.sync();
  tick(clock);
  b.sync();
  assert.deepEqual(b.checkinView().entry, { sleep: null, energy: null });
});

test('same-day edits on both PCs: the newer one wins on both', () => {
  const { a, b, clock } = setup();
  a.sync();
  b.sync();
  tick(clock);
  a.setCheckin(a.today(), { sleep: 6, energy: 2 });
  b.setCheckin(b.today(), { sleep: 7, energy: 3 });
  a.sync();
  tick(clock);
  b.sync(); // B's edit is newer: it keeps it
  tick(clock);
  assert.deepEqual(a.sync(), ['checkin']);
  assert.deepEqual(a.checkinView().entry, { sleep: 7, energy: 3 });
  assert.deepEqual(b.checkinView().entry, { sleep: 7, energy: 3 });
});

test('different days answered on two PCs add up', () => {
  const { a, b, clock } = setup();
  a.setCheckin(a.today(), { sleep: 8, energy: 4 });
  b.setCheckin(addDays(b.today(), -1), { sleep: 6, energy: 3 });
  a.sync();
  tick(clock);
  b.sync();
  tick(clock);
  a.sync();
  for (const p of [a, b]) {
    const days = checkin.loadCheckin(p.files.checkin).days;
    assert.deepEqual(Object.keys(days).sort(), [addDays(a.today(), -1), a.today()]);
  }
});

// --- habits --------------------------------------------------------------------------

test('habits: a new habit, its ticks and an untick round-trip', () => {
  const { a, b, clock } = setup();
  a.habit('add', { name: 'Read', every: 'week', perWeek: 2 });
  const id = a.habits().find((h) => h.name === 'Read').id;
  a.habit('tick', { id, date: a.today(), on: true });
  a.habit('tick', { id: 'water', date: a.today(), on: true });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['habits']);
  assert.deepEqual(b.habits(), a.habits());

  tick(clock);
  b.habit('tick', { id: 'water', date: b.today(), on: false });
  b.sync();
  tick(clock);
  assert.deepEqual(a.sync(), ['habits']);
  assert.deepEqual(a.habits().find((h) => h.id === 'water').done, []);
  assert.deepEqual(a.habits().find((h) => h.id === id).done, [a.today()]);
});

test('ticks on two PCs merge per day', () => {
  const { a, b, clock } = setup();
  a.habit('tick', { id: 'water', date: a.today(), on: true });
  a.sync();
  tick(clock);
  b.sync();
  tick(clock);
  b.habit('tick', { id: 'water', date: addDays(b.today(), -1), on: true });
  b.sync();
  tick(clock);
  a.sync();
  const want = [addDays(a.today(), -1), a.today()];
  assert.deepEqual(a.habits().find((h) => h.id === 'water').done, want);
  assert.deepEqual(b.habits().find((h) => h.id === 'water').done, want);
});

test('a deleted habit goes on every PC, its ticks with it', () => {
  const { a, b, clock } = setup();
  a.habit('tick', { id: 'gym', date: a.today(), on: true });
  a.sync();
  tick(clock);
  b.sync();
  assert.ok(b.habits().some((h) => h.id === 'gym'));
  tick(clock);
  a.habit('remove', { id: 'gym' });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['habits']);
  assert.ok(!b.habits().some((h) => h.id === 'gym'));
  tick(clock);
  assert.deepEqual(a.sync(), []); // the orphan tick in the cloud does not bring it back
  assert.ok(!a.habits().some((h) => h.id === 'gym'));
});

test('a delete beats an older edit but loses to a newer one', () => {
  const { a, b, clock } = setup();
  a.setCheckin(a.today(), { sleep: 8, energy: 4 });
  a.goal('set', { week: isoWeek(a.today()), goals: ['One'] });
  a.sync();
  tick(clock);
  b.sync();
  // B removes the habit 'snacks': A's older version loses to the tombstone.
  tick(clock);
  b.habit('remove', { id: 'snacks' });
  b.sync();
  tick(clock);
  a.sync();
  assert.ok(!a.habits().some((h) => h.id === 'snacks'));
  // A restores it later: the newer edit wins over B's tombstone.
  tick(clock);
  a.habit('restore', { habit: { id: 'snacks', name: '', every: 'day', perWeek: 7, auto: '', done: [] } });
  a.sync();
  tick(clock);
  b.sync();
  assert.ok(b.habits().some((h) => h.id === 'snacks'));
});

// --- goals and score -------------------------------------------------------------------

test('weekly goals and their status round-trip', () => {
  const { a, b, clock } = setup();
  const week = isoWeek(a.today());
  a.goal('set', { week, goals: ['Ship sync', 'Gym x3'] });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['goals']);
  assert.deepEqual(goals.goalsView(b.goals(), clock.t).goals, [
    { text: 'Ship sync', status: 'notyet' },
    { text: 'Gym x3', status: 'notyet' },
  ]);
  tick(clock);
  b.goal('status', { week, index: 0, status: 'done' });
  b.sync();
  tick(clock);
  a.sync();
  assert.equal(a.goals().weeks[week][0].status, 'done');
});

test('score settings round-trip as one unit', () => {
  const { a, b, clock } = setup();
  a.setScore({ weights: WEIGHTS, focusTargetH: 4.5 });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['score']);
  assert.deepEqual(b.score(), { v: 1, weights: WEIGHTS, focusTargetH: 4.5 });
});

// --- fresh PCs, damaged files, untrusted peers -----------------------------------------

test('a fresh PC never overwrites real data with its defaults', () => {
  const { a, b, clock, cloud } = setup();
  a.setScore({ weights: WEIGHTS, focusTargetH: 5 });
  a.habit('remove', { id: 'gym' });
  a.setCheckin(a.today(), { sleep: 8, energy: 4 });
  // The fresh PC syncs FIRST: it publishes nothing of its own defaults.
  b.sync();
  assert.deepEqual(Object.keys(cloud.mirror), []);
  for (const f of Object.values(b.files)) assert.equal(fs.existsSync(f), false);
  tick(clock);
  assert.deepEqual(a.sync(), []);
  assert.deepEqual(a.score().weights, WEIGHTS);
  assert.ok(!a.habits().some((h) => h.id === 'gym'));
  tick(clock);
  // Then it takes the real data, without the habit the real PC deleted.
  assert.deepEqual(b.sync().sort(), ['checkin', 'habits', 'score']);
  assert.deepEqual(b.score().weights, WEIGHTS);
  assert.deepEqual(b.habits().map((h) => h.id), a.habits().map((h) => h.id));
  assert.deepEqual(b.checkinView().entry, { sleep: 8, energy: 4 });
});

test('a fresh PC that ticks a habit before its first sync keeps the real renames and deletes', () => {
  const { a, b, clock } = setup();
  a.habit('edit', { id: 'gym', name: 'Lifting', every: 'week', perWeek: 3 });
  a.habit('remove', { id: 'snacks' });
  a.sync();
  tick(clock);
  // B never synced, yet a first write materialises its suggestion defaults
  // into a file whose mtime is newer than A's edits.
  b.habit('tick', { id: 'water', date: b.today(), on: true });
  fs.utimesSync(b.files.habits, new Date(clock.t + 500), new Date(clock.t + 500));
  tick(clock);
  b.sync();
  assert.equal(b.habits().find((h) => h.id === 'gym').name, 'Lifting');
  assert.ok(!b.habits().some((h) => h.id === 'snacks'));
  // B's own action (the tick) survives and reaches A.
  assert.deepEqual(b.habits().find((h) => h.id === 'water').done, [b.today()]);
  tick(clock);
  a.sync();
  assert.equal(a.habits().find((h) => h.id === 'gym').name, 'Lifting');
  assert.ok(!a.habits().some((h) => h.id === 'snacks'));
  assert.deepEqual(a.habits().find((h) => h.id === 'water').done, [a.today()]);
});

test('untouched default score settings never beat real ones on a first sync', () => {
  const { a, b, clock } = setup();
  a.setScore({ weights: WEIGHTS, focusTargetH: 5 });
  a.sync();
  tick(clock);
  b.setScore({ weights: { focus: 25, shipping: 25, goals: 25, health: 25 }, focusTargetH: 6 });
  fs.utimesSync(b.files.score, new Date(clock.t + 500), new Date(clock.t + 500));
  tick(clock);
  b.sync();
  assert.deepEqual(b.score().weights, WEIGHTS);
});

test('a lost local file is not "everything deleted": it comes back from the cloud', () => {
  const { a, b, clock } = setup();
  a.setCheckin(a.today(), { sleep: 8, energy: 4 });
  a.sync();
  tick(clock);
  b.sync();
  fs.rmSync(a.files.checkin);
  tick(clock);
  assert.deepEqual(a.sync(), ['checkin']);
  assert.deepEqual(a.checkinView().entry, { sleep: 8, energy: 4 });
  tick(clock);
  b.sync();
  assert.deepEqual(b.checkinView().entry, { sleep: 8, energy: 4 });
});

test('an unreadable or hand-damaged file is skipped before any write; other stores go on', () => {
  const { a, b, clock, cloud } = setup();
  a.setCheckin(a.today(), { sleep: 8, energy: 4 });
  a.setScore({ weights: WEIGHTS, focusTargetH: 5 });
  a.sync();
  tick(clock);
  b.sync();
  // B: check-in file half-written, score file hand-edited into invalid weights.
  fs.writeFileSync(b.files.checkin, '{"v":1,"days":{');
  fs.writeFileSync(b.files.score, JSON.stringify({ v: 1, weights: { focus: -1 }, focusTargetH: 5 }));
  tick(clock);
  a.goal('set', { week: isoWeek(a.today()), goals: ['Goal'] });
  a.sync();
  tick(clock);
  assert.deepEqual(b.sync(), ['goals']);
  assert.equal(fs.readFileSync(b.files.checkin, 'utf8'), '{"v":1,"days":{');
  assert.deepEqual(JSON.parse(fs.readFileSync(b.files.score, 'utf8')).weights, { focus: -1 });
  // Nothing of B's damage went out as a delete or an edit.
  assert.deepEqual(cloud.mirror[`life:ci:${a.today()}`].v, { sleep: 8, energy: 4 });
  assert.deepEqual(cloud.mirror['life:score'].v.weights, WEIGHTS);
  tick(clock);
  a.sync();
  assert.deepEqual(a.score().weights, WEIGHTS);
});

test('malformed peer units are dropped', () => {
  const { b, cloud, clock } = setup();
  const u = clock.t - 1000;
  const today = ymd(clock.t);
  const put = (k, v) => (cloud.mirror[k] = { v, u, d: null });
  put(`life:ci:${today}`, { sleep: 99, energy: 4 }); // out of range
  put('life:ci:2026-13-45', { sleep: 8, energy: 4 }); // not a day
  put(`life:ci:${addDays(today, -1)}`, { sleep: 8 }); // energy missing
  put('life:hb:aaa', { id: 'bbb', name: 'X', every: 'day', perWeek: 7, auto: '' }); // id mismatch
  put('life:hb:ok', { id: 'ok', name: 'Fine', every: 'day', perWeek: 7, auto: '' }); // valid
  put('life:hb:evil', { id: 'evil', name: '‮evil', every: 'day', perWeek: 7, auto: '' }); // bidi override
  put('life:hb:fake', { id: 'fake', name: 'Fake', every: 'day', perWeek: 7, auto: 'steps' }); // only 'steps' auto-ticks
  put(`life:ht:ok:${today}`, { on: true }); // a tick carries no data
  put(`life:ht:ok:${addDays(today, -1)}`, {}); // valid
  put('life:wg:2026-W99', { goals: [] }); // no such week
  put(`life:wg:${isoWeek(today)}`, { goals: [{ text: 'x', status: 'done' }], extra: 1 });
  put('life:score', { weights: { focus: 50, shipping: 50, goals: 0, health: 1 }, focusTargetH: 5 }); // not normalized
  put('life:other', { x: 1 }); // nobody owns it
  assert.doesNotThrow(() => b.sync());
  assert.deepEqual(checkin.loadCheckin(b.files.checkin).days, {});
  assert.deepEqual(b.habits(), [{ id: 'ok', name: 'Fine', every: 'day', perWeek: 7, auto: '', done: [addDays(today, -1)] }]);
  assert.deepEqual(b.goals().weeks, {});
  assert.equal(fs.existsSync(b.files.score), false);
});

test('lifeParts maps provider names to renderer parts and ignores the rest', () => {
  assert.deepEqual(lifeParts(['projects', 'lifeCheckin', 'lifeGoals', 'constructor']), ['checkin', 'goals']);
});

test('the providers never claim budget or other config keys', () => {
  const providers = lifeProviders({ checkin: 'x', habits: 'x', goals: 'x', score: 'x' });
  for (const k of ['income', 'e:abc', 'p:2026-10:rent', 'proj:entry:x', 'doc:prompts', 'host:default', 'news:source:x']) {
    assert.ok(providers.every((p) => !p.owns(k)), k);
  }
});
