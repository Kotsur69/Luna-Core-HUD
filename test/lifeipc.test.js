// ============================================================================
// LunaCore - Life dashboard IPC tests (life:budget, life:budget-do)
// ----------------------------------------------------------------------------
// Driven through a fake ipcMain against a temp budget file. The renderer is
// untrusted: every payload shape is probed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerLifeIpc } = require('../src/lifeipc.js');

const NOW = new Date(2026, 9, 14, 12).getTime();

// A clock that moves a second per reading, so back-to-back writes in a test
// are never mistaken for a looping renderer.
function harness({ clock } = {}) {
  const handlers = new Map();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lifeipc-')), 'life-budget.local.json');
  let tick = 0;
  const now = clock || (() => NOW + 1000 * tick++);
  registerLifeIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, file, now });
  const call = (ch, arg) => handlers.get(ch)({}, arg);
  return { call, file };
}

test('life:budget returns the summary plus the editable rows', async () => {
  const { call } = harness();
  const res = await call('life:budget');
  assert.equal(res.ok, true);
  assert.equal(res.summary.currency, 'PLN');
  assert.ok(Array.isArray(res.budget.categories));
  assert.deepEqual(res.budget.bills, []);
});

test('life:budget-do applies an op and answers with the fresh summary', async () => {
  const { call } = harness();
  await call('life:budget-do', { op: 'setIncome', data: { amount: 8000, payday: 10 } });
  const res = await call('life:budget-do', { op: 'addExpense', data: { date: '2026-10-14', amount: 45, category: 'food', note: '' } });
  assert.equal(res.ok, true);
  assert.equal(res.summary.spent, 45);
  assert.equal(res.summary.left, 7955);
});

test('bad payloads answer a reason, never throw across IPC', async () => {
  const { call } = harness();
  for (const req of [null, 'x', {}, { op: 'nope', data: {} }, { op: 'addExpense' }, { op: 'addExpense', data: { amount: -5 } }, { op: 'constructor', data: {} }]) {
    const res = await call('life:budget-do', req);
    assert.equal(res.ok, false, JSON.stringify(req));
    assert.equal(typeof res.reason, 'string');
  }
});

test('the reason is a fixed code, not a raw error message', async () => {
  const { call } = harness();
  const res = await call('life:budget-do', { op: 'addExpense', data: { date: 'x', amount: 1, category: 'food', note: '' } });
  assert.deepEqual(res, { ok: false, reason: 'bad-date' });
  const res2 = await call('life:budget-do', { op: 'deleteExpense', data: { id: 'missing' } });
  assert.deepEqual(res2, { ok: false, reason: 'not-found' });
});

test('writes faster than a person can click are refused', async () => {
  const { call } = harness({ clock: () => NOW });
  const first = await call('life:budget-do', { op: 'setIncome', data: { amount: 1, payday: 1 } });
  const second = await call('life:budget-do', { op: 'setIncome', data: { amount: 2, payday: 1 } });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'rate-limited' });
});

test('an unreadable budget file answers unreadable and is left alone', async () => {
  const { call, file } = harness();
  fs.writeFileSync(file, '{broken');
  const res = await call('life:budget-do', { op: 'setIncome', data: { amount: 1, payday: 1 } });
  assert.deepEqual(res, { ok: false, reason: 'unreadable' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('a filesystem failure is reported as a fixed code, not swallowed', async () => {
  const { call, file } = harness();
  // A directory where the file should be: the read before the write fails.
  fs.mkdirSync(file);
  const res = await call('life:budget-do', { op: 'setIncome', data: { amount: 1, payday: 1 } });
  assert.deepEqual(res, { ok: false, reason: 'unreadable' });
});
