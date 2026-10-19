// Phone Life model (mobile/src/lifemodel.js): what the phone writes must be
// merged unchanged by a PC's lifesync, and only the changed units go out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { budgetOf, opUnits } from '../mobile/src/lifemodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');
const { createLifeSync } = require('../src/lifesync');
const { normalize } = require('../src/lifebudgetrows');
const { toUnits } = require('../src/lifebudgetunits');

const NOW = new Date(2026, 9, 19, 12).getTime();
const PC_U = NOW - 60_000;

const BUDGET = normalize({
  income: { amount: 8000, payday: 10 },
  categories: [
    { id: 'food', name: '', kind: 'planned', plan: 1200 },
    { id: 'fun', name: '', kind: 'free', plan: 0 },
  ],
  expenses: [{ id: 'e1', date: '2026-10-12', amount: 50, category: 'food', note: '' }],
  bills: [
    { id: 'gas', name: 'Gas', expected: 400, dueDay: 15, kind: 'bill', every: 'month', month: 0 },
    { id: 'inv', name: 'Invest', expected: 500, dueDay: 11, kind: 'saving', every: 'month', month: 0, goal: 'pot' },
  ],
  goals: [{ id: 'pot', name: 'Pot', target: 10000, saved: 100, by: '' }],
  deposits: [{ id: 'd1', date: '2026-10-13', goal: 'pot', amount: 20, note: '' }],
});

/** Cloud units folded into a mirror, as cloud.js would after a pull. */
const mirrorOf = (units, base = { cursor: 0, mirror: {}, pushed: {} }) =>
  rows.applyRows(base, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: base.cursor + i + 1 })), NOW);

const pcUnits = () => toUnits(BUDGET).map(([k, v]) => ({ k, v, u: PC_U, d: null }));

test('budgetOf rebuilds the budget a PC published', () => {
  const { budget, ready } = budgetOf(mirrorOf(pcUnits()).mirror, NOW);
  assert.equal(ready, true);
  assert.deepEqual(budget, BUDGET);
});

test('an empty mirror is not ready and refuses writes', () => {
  assert.equal(budgetOf({}, NOW).ready, false);
  assert.throws(() => opUnits({}, 'addExpense', { date: '2026-10-19', amount: 5, category: 'other' }, NOW), /not-ready/);
});

test('addExpense sends one new unit, newer than anything it replaces', () => {
  const out = opUnits(mirrorOf(pcUnits()).mirror, 'addExpense', { date: '2026-10-19', amount: 12.5, category: 'fun', note: ' kebab ' }, NOW);
  assert.equal(out.length, 1);
  assert.match(out[0].k, /^e:[0-9a-f]{12}$/);
  assert.deepEqual({ ...out[0].v, id: 'x' }, { id: 'x', date: '2026-10-19', amount: 12.5, category: 'fun', note: 'kebab' });
  assert.equal(out[0].u, NOW);
  assert.equal(out[0].d, null);
});

test('an edit is stamped after the version it replaces, even with a slow clock', () => {
  const units = pcUnits().map((x) => (x.k === 'e:e1' ? { ...x, u: NOW + 5000 } : x));
  const [unit] = opUnits(mirrorOf(units).mirror, 'updateExpense', { id: 'e1', date: '2026-10-12', amount: 60, category: 'food' }, NOW);
  assert.equal(unit.k, 'e:e1');
  assert.equal(unit.u, NOW + 5001);
});

test('payBill writes only the payment unit', () => {
  const out = opUnits(mirrorOf(pcUnits()).mirror, 'payBill', { id: 'gas', month: '2026-10', amount: 380 }, NOW);
  assert.deepEqual(out, [{ k: 'p:2026-10:gas', v: { amount: 380, paidOn: '2026-10-19' }, u: NOW, d: null }]);
});

test('deleteGoal tombstones the goal and its deposits and unlinks the saving bill', () => {
  const out = opUnits(mirrorOf(pcUnits()).mirror, 'deleteGoal', { id: 'pot' }, NOW);
  const byKey = Object.fromEntries(out.map((x) => [x.k, x]));
  assert.deepEqual(Object.keys(byKey).sort(), ['b:inv', 'd:d1', 'g:pot']);
  assert.equal(byKey['b:inv'].v.goal, '');
  assert.equal(byKey['g:pot'].d, NOW);
  assert.equal(byKey['d:d1'].v, null);
});

test('a unit whose key does not match its row id cannot hide the real row', () => {
  const fake = { k: 'e:aaa', v: { ...BUDGET.expenses[0], note: 'fake' }, u: PC_U, d: null };
  const { budget } = budgetOf(mirrorOf([fake, ...pcUnits()]).mirror, NOW);
  assert.deepEqual(budget.expenses, BUDGET.expenses);
});

test('bad payloads throw instead of writing', () => {
  const { mirror } = mirrorOf(pcUnits());
  assert.throws(() => opUnits(mirror, 'addExpense', { date: '2026-10-19', amount: -1, category: 'fun' }, NOW));
  assert.throws(() => opUnits(mirror, 'addExpense', { date: '2026-10-19', amount: 5, category: 'nope' }, NOW));
  assert.throws(() => opUnits(mirror, 'dropTables', {}, NOW), /bad op/);
});

test('a PC sync merges the phone writes into its budget file unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-mobilelife-'));
  try {
    const budgetFile = path.join(dir, 'life-budget.local.json');
    fs.writeFileSync(budgetFile, JSON.stringify(BUDGET));
    // A first sync stamps the local file by its mtime: make it older than the cloud's PC units.
    const old = new Date(PC_U - 1000);
    fs.utimesSync(budgetFile, old, old);
    const state = mirrorOf(pcUnits());
    const phone = [
      ...opUnits(state.mirror, 'addExpense', { date: '2026-10-19', amount: 12.5, category: 'fun', note: 'kebab' }, NOW),
      ...opUnits(state.mirror, 'payBill', { id: 'gas', month: '2026-10', amount: 380 }, NOW),
      ...opUnits(state.mirror, 'deleteExpense', { id: 'e1' }, NOW),
    ];
    const cloud = mirrorOf(phone, state);
    const sync = createLifeSync({
      machine: 'KT-PC-LLM',
      metaFile: path.join(dir, 'life-sync.local.json'),
      budgetFile,
      now: () => NOW + 1000,
      extraPeers: () => [rows.lifePeer(cloud.mirror)],
    });
    assert.equal(sync.syncOnce(), true);
    const merged = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    assert.deepEqual(merged.expenses.map((e) => e.note), ['kebab']);
    assert.deepEqual(merged.payments, { '2026-10': { gas: { amount: 380, paidOn: '2026-10-19' } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
