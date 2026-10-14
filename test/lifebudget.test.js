// ============================================================================
// LunaCore - Life dashboard budget store (src/lifebudget.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/lifebudget.js');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-budget-')), 'life-budget.local.json');
const NOW = new Date(2026, 9, 14, 12).getTime();

test('a missing or broken file loads the default budget', () => {
  const f = file();
  const b = store.loadBudget(f);
  assert.equal(b.currency, 'PLN');
  assert.deepEqual(b.income, { amount: 0, payday: 1 });
  assert.ok(b.categories.some((c) => c.id === 'food'));
  assert.deepEqual([b.expenses, b.bills, b.goals], [[], [], []]);
  fs.writeFileSync(f, '{oops');
  assert.equal(store.loadBudget(f).currency, 'PLN');
});

test('income and payday are validated', () => {
  const f = file();
  store.apply('setIncome', { amount: 8000.555, payday: 10 }, f, NOW);
  assert.deepEqual(store.loadBudget(f).income, { amount: 8000.56, payday: 10 });
  assert.throws(() => store.apply('setIncome', { amount: -1, payday: 10 }, f, NOW), /bad amount/);
  assert.throws(() => store.apply('setIncome', { amount: 10, payday: 32 }, f, NOW), /bad day/);
});

test('expenses: add, edit, delete; ids come from the store, never the renderer', () => {
  const f = file();
  const b = store.apply('addExpense', { id: 'evil', date: '2026-10-14', amount: 45.5, category: 'food', note: 'lunch' }, f, NOW);
  const e = b.expenses[0];
  assert.notEqual(e.id, 'evil');
  assert.deepEqual({ ...e, id: 'x' }, { id: 'x', date: '2026-10-14', amount: 45.5, category: 'food', note: 'lunch' });
  store.apply('updateExpense', { id: e.id, date: '2026-10-13', amount: 40, category: 'fuel', note: '' }, f, NOW);
  assert.equal(store.loadBudget(f).expenses[0].amount, 40);
  store.apply('deleteExpense', { id: e.id }, f, NOW);
  assert.deepEqual(store.loadBudget(f).expenses, []);
});

test('expense validation: amount, date, note, category', () => {
  const f = file();
  const bad = (x) => assert.throws(() => store.apply('addExpense', { date: '2026-10-14', amount: 10, category: 'food', note: '', ...x }, f, NOW));
  bad({ amount: 0 });
  bad({ amount: '10' });
  bad({ amount: Infinity });
  bad({ amount: 1e9 });
  bad({ date: '2026-13-01' });
  bad({ date: '2026-02-30' });
  bad({ note: 'x'.repeat(201) });
  bad({ note: 'a\u0007b' });
  bad({ category: 'nope' });
});

test('an unknown expense id is an error, not a silent no-op', () => {
  assert.throws(() => store.apply('updateExpense', { id: 'missing', date: '2026-10-14', amount: 1, category: 'food', note: '' }, file(), NOW), /not found/);
});

test('bills: expected amount, then an editable actual payment', () => {
  const f = file();
  const b = store.apply('saveBill', { name: 'Gas', expected: 400, dueDay: 20, kind: 'bill', every: 'month', month: 0, category: 'home' }, f, NOW);
  const id = b.bills[0].id;
  store.apply('payBill', { id, month: '2026-10', amount: 200 }, f, NOW);
  assert.deepEqual(store.loadBudget(f).payments['2026-10'][id], { amount: 200, paidOn: '2026-10-14' });
  // Paid entries stay editable.
  store.apply('payBill', { id, month: '2026-10', amount: 215.3 }, f, NOW);
  assert.equal(store.loadBudget(f).payments['2026-10'][id].amount, 215.3);
  store.apply('unpayBill', { id, month: '2026-10' }, f, NOW);
  assert.equal(store.loadBudget(f).payments['2026-10'], undefined);
});

test('editing a bill keeps its id; deleting it drops its payments', () => {
  const f = file();
  const id = store.apply('saveBill', { name: 'Gas', expected: 400, dueDay: 20, kind: 'bill', every: 'month', month: 0, category: '' }, f, NOW).bills[0].id;
  store.apply('payBill', { id, month: '2026-10', amount: 200 }, f, NOW);
  store.apply('saveBill', { id, name: 'Gas (PGNiG)', expected: 350, dueDay: 21, kind: 'bill', every: 'month', month: 0, category: '' }, f, NOW);
  const b = store.loadBudget(f);
  assert.deepEqual([b.bills.length, b.bills[0].id, b.bills[0].expected], [1, id, 350]);
  store.apply('deleteBill', { id }, f, NOW);
  assert.deepEqual(store.loadBudget(f).payments, {});
});

test('bill validation: yearly needs a month, kind/every are enums', () => {
  const f = file();
  const bad = (x) => assert.throws(() => store.apply('saveBill', { name: 'X', expected: 10, dueDay: 1, kind: 'bill', every: 'month', month: 0, category: '', ...x }, f, NOW));
  bad({ every: 'year', month: 0 });
  bad({ kind: 'loan' });
  bad({ every: 'week' });
  bad({ dueDay: 0 });
  bad({ name: '' });
  bad({ id: 'missing' });
  assert.throws(() => store.apply('payBill', { id: 'missing', month: '2026-10', amount: 1 }, f, NOW), /not found/);
});

test('categories: add with a limit, edit, delete', () => {
  const f = file();
  const b = store.apply('saveCategory', { name: 'Coffee', limit: 200 }, f, NOW);
  const cat = b.categories.find((c) => c.name === 'Coffee');
  assert.equal(cat.limit, 200);
  store.apply('saveCategory', { id: 'food', name: '', limit: 1500 }, f, NOW);
  assert.equal(store.loadBudget(f).categories.find((c) => c.id === 'food').limit, 1500);
  store.apply('deleteCategory', { id: cat.id }, f, NOW);
  assert.equal(store.loadBudget(f).categories.some((c) => c.id === cat.id), false);
});

test('savings goals: save and delete, by is YYYY-MM', () => {
  const f = file();
  const b = store.apply('saveGoal', { name: 'Tires', target: 2000, saved: 500, by: '2027-04' }, f, NOW);
  assert.deepEqual({ ...b.goals[0], id: 'x' }, { id: 'x', name: 'Tires', target: 2000, saved: 500, by: '2027-04' });
  assert.throws(() => store.apply('saveGoal', { name: 'X', target: 1, saved: 0, by: '2027-13' }, f, NOW));
  store.apply('deleteGoal', { id: b.goals[0].id }, f, NOW);
  assert.deepEqual(store.loadBudget(f).goals, []);
});

test('an unknown op is rejected', () => {
  assert.throws(() => store.apply('__proto__', {}, file(), NOW), /bad op/);
  assert.throws(() => store.apply('loadBudget', {}, file(), NOW), /bad op/);
});

test('an unreadable file is never overwritten by a write (no silent wipe)', () => {
  const f = file();
  fs.writeFileSync(f, '{"income": {"amount": 5000, "payday": 10}, "expenses": [');
  assert.throws(() => store.apply('setIncome', { amount: 1, payday: 1 }, f, NOW), /unreadable/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"income": {"amount": 5000, "payday": 10}, "expenses": [');
});

test('writes are atomic: no temp file left behind, content complete', () => {
  const f = file();
  store.apply('setIncome', { amount: 100, payday: 5 }, f, NOW);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), [path.basename(f)]);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).income.amount, 100);
});

test('a write that would drop hand-edited junk rows keeps a .bak of the original first', () => {
  const f = file();
  const raw = JSON.stringify({ income: { amount: 5000, payday: 10 }, expenses: [{ id: 'bad', date: 'never', amount: 5 }] });
  fs.writeFileSync(f, raw);
  store.apply('setIncome', { amount: 6000, payday: 10 }, f, NOW);
  assert.equal(fs.readFileSync(`${f}.bak`, 'utf8'), raw);
});

test('the expense cap refuses instead of evicting history', () => {
  const f = file();
  const expenses = Array.from({ length: 5000 }, (_, i) => ({ id: `e${i}`, date: '2026-10-01', amount: 1, category: 'food', note: '' }));
  fs.writeFileSync(f, JSON.stringify({ income: { amount: 1, payday: 1 }, expenses }));
  assert.throws(() => store.apply('addExpense', { date: '2026-10-14', amount: 1, category: 'food', note: '' }, f, NOW), /too many/);
  assert.equal(store.loadBudget(f).expenses.length, 5000);
});

test('a payment month must be within a year of now', () => {
  const f = file();
  const id = store.apply('saveBill', { name: 'Gas', expected: 400, dueDay: 20, kind: 'bill', every: 'month', month: 0, category: '' }, f, NOW).bills[0].id;
  assert.throws(() => store.apply('payBill', { id, month: '9999-12', amount: 1 }, f, NOW), /bad month/);
  assert.throws(() => store.apply('payBill', { id, month: '2024-01', amount: 1 }, f, NOW), /bad month/);
  store.apply('payBill', { id, month: '2027-10', amount: 1 }, f, NOW);
});

test('amounts that round to zero, ancient dates and bidi/zero-width text are rejected', () => {
  const f = file();
  const bad = (x) => assert.throws(() => store.apply('addExpense', { date: '2026-10-14', amount: 10, category: 'food', note: '', ...x }, f, NOW));
  bad({ amount: 0.004 });
  bad({ date: '0099-01-01' });
  bad({ date: '1999-12-31' });
  bad({ note: 'abc‮def' });
  bad({ note: 'a​b' });
  bad({ note: 'a\u0085b' });
});

test('a hand-edited file with junk rows keeps only valid rows', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      currency: 'PLN',
      income: { amount: 5000, payday: 10 },
      expenses: [{ id: 'a1', date: '2026-10-01', amount: 5, category: 'food', note: '' }, { id: 'a2', date: 'never', amount: 5 }],
      bills: [{ id: 'b1', name: 'Gas', expected: 1, dueDay: 99 }],
    })
  );
  const b = store.loadBudget(f);
  assert.equal(b.income.amount, 5000);
  assert.deepEqual(b.expenses.map((e) => e.id), ['a1']);
  assert.deepEqual(b.bills, []);
});
