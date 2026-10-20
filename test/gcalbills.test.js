// ============================================================================
// LunaCore - bills as Google Calendar events tests (src/gcalbills.js,
// lifebudgetrows setBillEvent, lifeipc life:bill-cal-add)
// ----------------------------------------------------------------------------
// gcal is a fake; the budget store is the real one on a temp file.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/lifebudget.js');
const { createBillCalendar, TAG_KEY } = require('../src/gcalbills.js');
const { registerLifeIpc } = require('../src/lifeipc.js');

const KEY = '0123456789abcdef';
const NOW = new Date(2026, 9, 20, 12).getTime();

function budgetFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'billcal-')), 'life-budget.local.json');
  store.apply('saveBill', { name: 'Prad', expected: 200, dueDay: 31, kind: 'bill', every: 'month', month: 0 }, file, NOW);
  return { file, bill: store.loadBudget(file).bills[0] };
}

function fakeGcal() {
  const g = { created: [], updated: [], deleted: [], events: new Map() };
  g.listCalendars = async () => [{ key: KEY }];
  g.createEvent = async (key, draft, cats, opts) => {
    g.created.push({ key, draft, opts });
    const id = `ev${g.created.length}`;
    g.events.set(id, { id, extendedProperties: { private: opts.tag } });
    return { event: { id } };
  };
  g.updateEvent = async (id, draft, cats, opts) => {
    g.updated.push({ id, draft, opts });
    return { event: { id } };
  };
  g.eventByKey = async (method, key, id) => {
    if (method === 'DELETE') {
      g.deleted.push(id);
      return {};
    }
    const ev = g.events.get(id);
    if (!ev) throw Object.assign(new Error('HTTP 404 on /x'), { reason: 'gcal-failed' });
    return ev;
  };
  return g;
}

test('add makes one all-day monthly event, tagged, and links it on the bill', async () => {
  const { file, bill } = budgetFile();
  const gcal = fakeGcal();
  let clock = NOW;
  const cal = createBillCalendar({ gcal, store, file, now: () => clock });
  const { calEvent } = await cal.add(bill.id, KEY);
  assert.deepEqual(calEvent, { id: 'ev1', cal: KEY });
  const c = gcal.created[0];
  assert.equal(c.key, KEY);
  assert.deepEqual(c.draft, { title: 'Prad', start: '2026-10-31', end: '2026-11-01', allDay: true, location: '', category: null });
  assert.deepEqual(c.opts.recurrence, ['RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1']);
  assert.deepEqual(c.opts.tag, { [TAG_KEY]: bill.id });
  assert.deepEqual(store.loadBudget(file).bills[0].calEvent, { id: 'ev1', cal: KEY });
  clock += 5000;
  await assert.rejects(cal.add(bill.id, KEY), (err) => err.reason === 'already-added');
  assert.equal(gcal.created.length, 1);
});

test('add validates the key and throttles creates', async () => {
  const { file, bill } = budgetFile();
  const gcal = fakeGcal();
  const cal = createBillCalendar({ gcal, store, file, now: () => NOW });
  await assert.rejects(cal.add(bill.id, 'not-a-key'), (err) => err.reason === 'bad-input');
  await assert.rejects(cal.add('nope', KEY), (err) => err.reason === 'not-found');
  store.apply('saveBill', { name: 'Gaz', expected: 50, dueDay: 3, kind: 'bill', every: 'month', month: 0 }, file, NOW);
  const gaz = store.loadBudget(file).bills[1];
  await cal.add(bill.id, KEY);
  await assert.rejects(cal.add(gaz.id, KEY), (err) => err.reason === 'rate-limited');
});

test('saveBill keeps the calendar link; the form cannot set or change it', () => {
  const { file, bill } = budgetFile();
  store.apply('setBillEvent', { id: bill.id, calEvent: { id: 'ev1', cal: KEY } }, file, NOW);
  store.apply('saveBill', { ...bill, dueDay: 5, calEvent: { id: 'evil', cal: 'ffffffffffffffff' } }, file, NOW);
  const after = store.loadBudget(file).bills[0];
  assert.equal(after.dueDay, 5);
  assert.deepEqual(after.calEvent, { id: 'ev1', cal: KEY });
  assert.throws(() => store.apply('setBillEvent', { id: bill.id, calEvent: { id: 'a b', cal: KEY } }, file, NOW), /bad value/);
  store.apply('setBillEvent', { id: bill.id, calEvent: null }, file, NOW);
  assert.equal('calEvent' in store.loadBudget(file).bills[0], false);
});

test('a due-day edit patches the event; a foreign event id is never touched', async () => {
  const { file, bill } = budgetFile();
  const gcal = fakeGcal();
  const cal = createBillCalendar({ gcal, store, file, now: () => NOW });
  await cal.add(bill.id, KEY);
  const before = store.loadBudget(file);
  const after = store.apply('saveBill', { ...before.bills[0], dueDay: 10 }, file, NOW);
  await cal.onApplied('saveBill', before, after);
  assert.equal(gcal.updated.length, 1);
  assert.deepEqual(gcal.updated[0].opts, { calendar: KEY, recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=10'] });
  assert.equal(gcal.updated[0].draft.start, '2026-11-10');

  // A synced row pointing at someone else's event: refused, not edited.
  gcal.events.set('meeting', { id: 'meeting', extendedProperties: { private: {} } });
  store.apply('setBillEvent', { id: bill.id, calEvent: { id: 'meeting', cal: KEY } }, file, NOW);
  const b2 = store.loadBudget(file);
  const a2 = store.apply('saveBill', { ...b2.bills[0], dueDay: 12 }, file, NOW);
  await cal.onApplied('saveBill', b2, a2);
  assert.equal(gcal.updated.length, 1);
});

test('deleting a bill deletes its event only when confirmed', async () => {
  for (const yes of [true, false]) {
    const { file, bill } = budgetFile();
    const gcal = fakeGcal();
    const asked = [];
    const cal = createBillCalendar({ gcal, store, file, now: () => NOW, confirmDelete: async (name) => (asked.push(name), yes) });
    await cal.add(bill.id, KEY);
    const before = store.loadBudget(file);
    const after = store.apply('deleteBill', { id: bill.id }, file, NOW);
    await cal.onApplied('deleteBill', before, after);
    assert.deepEqual(asked, ['Prad']);
    assert.deepEqual(gcal.deleted, yes ? ['ev1'] : []);
  }
});

test('lifeipc refuses setBillEvent from the renderer and answers bill-cal-add', async () => {
  const { file, bill } = budgetFile();
  const handlers = {};
  const gcal = fakeGcal();
  const billCal = createBillCalendar({ gcal, store, file, now: () => NOW });
  registerLifeIpc({ ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) }, file, now: () => NOW, yazio: { status: () => ({ connected: false }) }, bodyEveryMs: 0, billCal });
  const refused = await handlers['life:budget-do'](null, { op: 'setBillEvent', data: { id: bill.id, calEvent: { id: 'x', cal: KEY } } });
  assert.deepEqual(refused, { ok: false, reason: 'bad-op' });
  const res = await handlers['life:bill-cal-add'](null, { billId: bill.id, calendar: KEY });
  assert.equal(res.ok, true);
  assert.deepEqual(res.budget.bills[0].calEvent, { id: 'ev1', cal: KEY });
  assert.deepEqual(await handlers['life:bill-cal-add'](null, { billId: bill.id, calendar: 'zz' }), { ok: false, reason: 'bad-input' });
});
