// ============================================================================
// LunaCore - Life budget sync between PCs (src/lifesync.js)
// ----------------------------------------------------------------------------
// Expenses added on two PCs must ADD UP, never overwrite each other; edits and
// deletes sync too, newest wins. A fresh PC or a locked file must never wipe
// the real budget.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/lifebudget.js');
const { createLifeSync, toUnits, fromUnits, validPeer } = require('../src/lifesync.js');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-lifesync-${tag}-`));

/** One simulated PC: its own config dir, the shared folder, a settable clock. */
function pc(machine, shared, clock) {
  const dir = tmp(machine);
  const budgetFile = path.join(dir, 'life-budget.local.json');
  const sync = createLifeSync({
    sharedDir: () => shared,
    machine,
    metaFile: path.join(dir, 'life-sync.local.json'),
    budgetFile,
    now: () => clock.t,
  });
  return {
    budgetFile,
    sync: () => sync.syncOnce(),
    apply: (op, data) => store.apply(op, data, budgetFile, clock.t),
    budget: () => store.loadBudget(budgetFile),
  };
}

function setup() {
  const shared = tmp('shared');
  const clock = { t: Date.UTC(2026, 9, 14, 12) };
  return { shared, clock, a: pc('PC-A', shared, clock), b: pc('PC-B', shared, clock) };
}

const expense = (amount, note) => ({ date: '2026-10-14', amount, category: 'food', note });
const notes = (b) => b.expenses.map((e) => e.note).sort();

test('units round-trip a budget unchanged', () => {
  const { a } = setup();
  a.apply('setIncome', { amount: 9000, payday: 10 });
  a.apply('addExpense', expense(12.5, 'bread'));
  a.apply('saveBill', { name: 'Rent', expected: 2000, dueDay: 5, kind: 'bill', every: 'month', month: 0 });
  const b = a.budget();
  assert.deepEqual(fromUnits(toUnits(b)), b);
});

test('no shared folder: sync is a no-op', () => {
  const dir = tmp('none');
  const sync = createLifeSync({ sharedDir: () => null, machine: 'PC-A', metaFile: path.join(dir, 'm.json'), budgetFile: path.join(dir, 'b.json') });
  assert.equal(sync.syncOnce(), false);
  assert.equal(fs.existsSync(path.join(dir, 'm.json')), false);
});

test('expenses added on two PCs add up', () => {
  const { clock, a, b } = setup();
  a.apply('addExpense', expense(10, 'from A'));
  b.apply('addExpense', expense(20, 'from B'));
  a.sync();
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.deepEqual(notes(a.budget()), ['from A', 'from B']);
  assert.deepEqual(notes(b.budget()), ['from A', 'from B']);
});

test('a fresh PC with no budget file never overwrites the real one', () => {
  const { clock, a, b } = setup();
  a.apply('setIncome', { amount: 9000, payday: 10 });
  a.apply('saveCategory', { id: 'food', name: '', kind: 'planned', plan: 1500 });
  clock.t += 1000;
  // B has never saved anything: its defaults (income 0, plan 0) sync first.
  b.sync();
  a.sync();
  b.sync();
  for (const pcBudget of [a.budget(), b.budget()]) {
    assert.equal(pcBudget.income.amount, 9000);
    assert.equal(pcBudget.categories.find((c) => c.id === 'food').plan, 1500);
  }
});

test('the newest edit of the same row wins', () => {
  const { clock, a, b } = setup();
  a.apply('setIncome', { amount: 5000, payday: 1 });
  a.sync();
  b.sync();
  clock.t += 1000;
  b.apply('setIncome', { amount: 7000, payday: 1 });
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.equal(a.budget().income.amount, 7000);
});

test('a delete on one PC removes the row everywhere and does not come back', () => {
  const { clock, a, b } = setup();
  a.apply('addExpense', expense(10, 'oops'));
  a.sync();
  b.sync();
  assert.deepEqual(notes(b.budget()), ['oops']);
  clock.t += 1000;
  const id = b.budget().expenses[0].id;
  b.apply('deleteExpense', { id });
  b.sync();
  clock.t += 1000;
  a.sync();
  b.sync();
  assert.deepEqual(notes(a.budget()), []);
  assert.deepEqual(notes(b.budget()), []);
});

test('an unreadable local budget aborts the sync and writes nothing', () => {
  const { shared, a, b } = setup();
  a.apply('addExpense', expense(10, 'keep me'));
  a.sync();
  const published = fs.readFileSync(path.join(shared, 'life-budget-PC-A.json'), 'utf8');
  fs.writeFileSync(a.budgetFile, '{ half a fi', 'utf8');
  assert.throws(() => a.sync(), /unreadable/);
  assert.equal(fs.readFileSync(path.join(shared, 'life-budget-PC-A.json'), 'utf8'), published);
  // The other PC still gets the real data, no tombstones were published.
  b.sync();
  assert.deepEqual(notes(b.budget()), ['keep me']);
});

test('a deleted local file is restored from the peers, not spread as a wipe', () => {
  const { clock, a, b } = setup();
  a.apply('addExpense', expense(10, 'precious'));
  a.sync();
  b.sync();
  fs.rmSync(a.budgetFile);
  clock.t += 1000;
  a.sync();
  b.sync();
  assert.deepEqual(notes(a.budget()), ['precious']);
  assert.deepEqual(notes(b.budget()), ['precious']);
});

test('a parseable but damaged local file aborts the sync instead of spreading deletions', () => {
  const { clock, a, b } = setup();
  a.apply('addExpense', expense(10, 'keep me'));
  a.sync();
  b.sync();
  fs.writeFileSync(a.budgetFile, '{}', 'utf8');
  clock.t += 1000;
  assert.throws(() => a.sync(), /suspect/);
  b.sync();
  assert.deepEqual(notes(b.budget()), ['keep me']);
});

test('a lone PC that lost its budget file gets it back from its own published copy', () => {
  const { clock, a } = setup();
  a.apply('addExpense', expense(10, 'only copy'));
  a.sync();
  fs.rmSync(a.budgetFile);
  clock.t += 1000;
  a.sync();
  assert.deepEqual(notes(a.budget()), ['only copy']);
});

test('peer units that fail validation are dropped', () => {
  const now = Date.UTC(2026, 9, 14);
  const peer = validPeer(
    {
      units: [
        { k: 'e:aaa', v: { id: 'aaa', date: '2026-10-14', amount: 5, category: 'food', note: 'ok' }, u: 1 },
        { k: 'e:bbb', v: { id: 'bbb', date: '2026-10-14', amount: -5, category: 'food', note: '' }, u: 1 },
        { k: 'e:ccc', v: { id: 'zzz', date: '2026-10-14', amount: 5, category: 'food', note: '' }, u: 1 },
        { k: '../evil', v: {}, u: 1 },
        { k: 'e:ddd', v: null, u: 1 },
        { k: 'e:eee', v: { id: 'eee', date: '2026-10-14', amount: 5, category: 'food', note: '' }, u: now + 365 * 864e5 },
      ],
      gone: { 'e:fff': 1, 'nope': 1 },
    },
    now,
  );
  assert.deepEqual(peer.units.map((x) => x.k), ['e:aaa']);
  assert.deepEqual(peer.gone, { 'e:fff': 1 });
});
