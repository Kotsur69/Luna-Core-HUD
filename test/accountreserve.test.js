// Tests for per-account usage reserve caps (src/accountreserve.js), how the
// account store applies them (src/claudeaccounts.js: auto-pick, failover,
// list, usageTargets), click-to-switch (moveToTop + the make-active IPC) and
// the Usage panel helpers (src/renderer/modules/usage.js).
//
// Why this file matters: a cap that is ignored burns the reserve Mati keeps on
// an account; a cap that is mis-read blocks a healthy account; an old store
// without the field must still load on a PC that has not updated.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateReserve, cleanReserve, parseCap, capFor, reserveUntil, reserveLimits,
} = require('../src/accountreserve');
const { createClaudeAccounts, sanitize } = require('../src/claudeaccounts');
const { createTabFailover } = require('../src/claudefailover');
const { registerClaudeAccountsIpc } = require('../src/claudeaccountsipc');
const {
  switchToAccount, isSwitchable, reserveCapFor, rowDimState,
} = require('../src/renderer/modules/usage.js');

// Assembled at runtime so no full token shape sits in the source.
const fakeToken = (ch) => `${['sk', 'ant', 'oat01'].join('-')}-${ch.repeat(40)}`;
const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 17, 12);
const iso = (ms) => new Date(ms).toISOString();

const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

/** A store on a temp file; `readings` stands in for the usage reader's cache. */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reserve-'));
  const file = path.join(dir, 'claude-accounts.local.json');
  const clock = { now: START };
  const readings = new Map();
  const store = createClaudeAccounts({
    file: () => file,
    safeStorage: fakeStorage,
    now: () => clock.now,
    reserveLimits: (accounts, t) => reserveLimits(accounts, readings, t),
  });
  return { store, file, clock, readings, dir };
}

const usage = (five, week, now = START) => [
  { window: '5h', percentUsed: five, resetsAt: iso(now + 2 * HOUR) },
  { window: 'weekly', percentUsed: week, resetsAt: iso(now + 72 * HOUR) },
];

// ---- validation ------------------------------------------------------------

test('validateReserve: integers 1-100, digit strings and empty pass; everything else is refused', () => {
  assert.deepEqual(validateReserve({ fiveHour: 50, weekly: 70 }), { ok: true, reserve: { fiveHour: 50, weekly: 70 } });
  assert.deepEqual(validateReserve({ fiveHour: '1', weekly: ' 100 ' }), { ok: true, reserve: { fiveHour: 1, weekly: 100 } });
  assert.deepEqual(validateReserve({ fiveHour: '', weekly: null }), { ok: true, reserve: {} });
  assert.deepEqual(validateReserve({}), { ok: true, reserve: {} });
  for (const bad of [0, 101, -5, 50.5, '0', '101', '5e1', '50%', 'abc', '0x10', NaN, Infinity, true, [], {}]) {
    assert.deepEqual(validateReserve({ fiveHour: bad }), { ok: false, error: 'badReserve' }, `fiveHour ${String(bad)}`);
    assert.deepEqual(validateReserve({ weekly: bad }), { ok: false, error: 'badReserve' }, `weekly ${String(bad)}`);
  }
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(validateReserve(bad), { ok: false, error: 'badReserve' });
  }
  assert.equal(parseCap(undefined), null);
  assert.equal(parseCap('  '), null);
});

test('cleanReserve: an old record without the field, or junk, means no cap', () => {
  assert.equal(cleanReserve(undefined), null);
  assert.equal(cleanReserve(null), null);
  assert.equal(cleanReserve('50'), null);
  assert.equal(cleanReserve([50, 70]), null);
  assert.equal(cleanReserve({ fiveHour: 0, weekly: 'x' }), null);
  // A bad field is dropped alone; strings are not accepted from disk.
  assert.deepEqual(cleanReserve({ fiveHour: 50, weekly: 170 }), { fiveHour: 50 });
  assert.deepEqual(cleanReserve({ fiveHour: '50', weekly: 70, extra: 1 }), { weekly: 70 });
});

test('sanitize: old accounts load untouched, valid caps survive, junk caps are dropped', () => {
  const home = os.homedir();
  const data = {
    accounts: [
      { id: 'old', label: 'Old', token: fakeToken('a') },
      { id: 'cap', label: 'Cap', token: fakeToken('b'), reserve: { fiveHour: 50, weekly: 70 } },
      { id: 'junk', label: 'Junk', token: fakeToken('c'), reserve: { fiveHour: 500 } },
    ],
  };
  const { accounts } = sanitize(data, home);
  assert.deepEqual(accounts.map((a) => a.id), ['old', 'cap', 'junk']);
  assert.equal('reserve' in accounts[0], false);
  assert.deepEqual(accounts[1].reserve, { fiveHour: 50, weekly: 70 });
  assert.equal('reserve' in accounts[2], false);
});

// ---- the cap check -----------------------------------------------------------

test('reserveUntil: at or over a cap -> that window\'s reset; under it, past resets and no data -> null', () => {
  const reserve = { fiveHour: 50, weekly: 70 };
  assert.equal(reserveUntil(reserve, usage(49, 69), START), null);
  assert.equal(reserveUntil(reserve, usage(50, 10), START), START + 2 * HOUR);
  assert.equal(reserveUntil(reserve, usage(10, 70), START), START + 72 * HOUR);
  // Both reached: the later reset holds it back.
  assert.equal(reserveUntil(reserve, usage(90, 90), START), START + 72 * HOUR);
  // The window already reset: the old reading no longer counts.
  assert.equal(reserveUntil(reserve, usage(90, 10, START - 3 * HOUR), START), null);
  // No readable reset: an hour, like a real limit without one.
  assert.equal(reserveUntil({ fiveHour: 50 }, [{ window: '5h', percentUsed: 60 }], START), START + HOUR);
  assert.equal(reserveUntil(reserve, [], START), null);
  assert.equal(reserveUntil(reserve, undefined, START), null);
  assert.equal(reserveUntil(null, usage(100, 100), START), null);
  assert.equal(capFor({ weekly: 70 }, { window: '5h' }), null);
  assert.equal(capFor({ weekly: 70 }, { window: 'weekly' }), 70);
});

test('reserveLimits: only capped accounts with a reading at the cap', () => {
  const accounts = [
    { id: 'a', reserve: { fiveHour: 50 } },
    { id: 'b' },
    { id: 'c', reserve: { weekly: 70 } },
    { id: 'd', reserve: { fiveHour: 10 } },
  ];
  const readings = new Map([['a', usage(55, 0)], ['b', usage(100, 100)], ['c', usage(0, 20)]]);
  assert.deepEqual(reserveLimits(accounts, readings, START), { a: START + 2 * HOUR });
  assert.deepEqual(reserveLimits(accounts, null, START), {});
});

// ---- the store: auto-pick and failover skip a capped account -------------------

function seed(store) {
  const a = store.add('Main', fakeToken('a'));
  const b = store.add('Spare', fakeToken('b'));
  assert.equal(a.ok && b.ok, true);
  return { a: a.id, b: b.id };
}

test('store: an account at its cap is skipped by the auto-pick and marked in list()', () => {
  const { store, readings, clock } = makeStore();
  const { a, b } = seed(store);
  clock.now += 1;
  assert.equal(store.active().id, a);
  assert.deepEqual(store.setReserve(a, { fiveHour: 50, weekly: 70 }), { ok: true });
  readings.set(a, usage(40, 10));
  assert.equal(store.active().id, a, 'under the cap the preferred account stays');
  readings.set(a, usage(50, 10));
  assert.equal(store.active().id, b);
  assert.deepEqual(store.freeAccount(), { id: b, label: 'Spare' });
  const view = store.list().accounts;
  assert.equal(view[0].reserveHit, true);
  assert.equal(view[0].limitedUntil, START + 2 * HOUR);
  assert.deepEqual(view[0].reserve, { fiveHour: 50, weekly: 70 });
  assert.equal(view[1].active, true);
  assert.deepEqual(view[1].reserve, { fiveHour: null, weekly: null });
  // The usage panel's dot follows the same pick.
  assert.deepEqual(store.usageTargets().map((t) => t.active), [false, true]);
  // The cap was never written as a cooldown: lifting it frees the account at once.
  assert.deepEqual(store.setReserve(a, {}), { ok: true });
  assert.equal(store.active().id, a);
});

test('store: a real limit that outlasts the cap is reported as a limit, not a reserve', () => {
  const { store, readings } = makeStore();
  const { a } = seed(store);
  store.setReserve(a, { fiveHour: 50 });
  readings.set(a, usage(60, 10));
  store.markLimited(a, START + 10 * HOUR);
  const row = store.list().accounts[0];
  assert.equal(row.limitedUntil, START + 10 * HOUR);
  assert.equal(row.reserveHit, false, 'clearing the real limit is still worth offering');
});

test('store: failover does not move work onto an account at its cap', () => {
  const { store, readings } = makeStore();
  const { a, b } = seed(store);
  store.setReserve(b, { weekly: 70 });
  readings.set(b, usage(5, 80));
  const res = store.markLimited(a, START + HOUR);
  assert.equal(res.switchTo, null, 'the only other account is at its cap');
  readings.set(b, usage(5, 20));
  store.clearLimit(a);
  const again = store.markLimited(a, START + HOUR);
  assert.deepEqual(again.switchTo, { id: b, label: 'Spare' });
});

test('per-tab failover skips a capped account like a limited one', () => {
  const { store, readings } = makeStore();
  const { a, b } = seed(store);
  store.setReserve(b, { fiveHour: 30 });
  readings.set(b, usage(30, 0));
  const restarted = [];
  const { failoverTab } = createTabFailover({
    accounts: store,
    getProfile: () => ({ command: 'claude', args: [] }),
    withAccountResume: () => 'claude --resume x',
    restartSession: (s) => restarted.push(s.id),
    send: () => {},
    defer: (fn) => fn(),
  });
  const session = { id: 's1', accountId: a, transcriptId: 'x', profileId: 'p' };
  assert.equal(failoverTab(session, START + HOUR), false);
  assert.deepEqual(restarted, []);
});

test('store: a failing reserve source never breaks a pick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reserve-'));
  const lines = [];
  const store = createClaudeAccounts({
    file: () => path.join(dir, 'claude-accounts.local.json'),
    safeStorage: fakeStorage,
    now: () => START,
    log: (l) => lines.push(l),
    reserveLimits: () => { throw new Error('boom'); },
  });
  const { a } = seed(store);
  assert.equal(store.active().id, a);
  store.active();
  assert.equal(lines.filter((l) => l.includes('reserve check failed (boom)')).length, 1);
});

test('store: caps survive a reload from disk; setReserve on an unknown id is refused', () => {
  const { store, file } = makeStore();
  const { a } = seed(store);
  store.setReserve(a, { fiveHour: 50 });
  const again = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, now: () => START });
  assert.deepEqual(again.list().accounts[0].reserve, { fiveHour: 50, weekly: null });
  assert.deepEqual(store.setReserve('nope', { fiveHour: 50 }), { ok: false, error: 'notFound' });
});

// ---- click to switch -----------------------------------------------------------

test('moveToTop makes the account the one new work runs on', () => {
  const { store } = makeStore();
  const { a, b } = seed(store);
  assert.equal(store.active().id, a);
  assert.deepEqual(store.moveToTop(b), { ok: true });
  assert.equal(store.active().id, b);
  assert.deepEqual(store.list().accounts.map((x) => x.id), [b, a]);
  assert.deepEqual(store.moveToTop(b), { ok: true }, 'already first: no-op');
  assert.deepEqual(store.moveToTop('zzz'), { ok: false, error: 'notFound' });
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) } };
}

test('IPC make-active: main rejects a malformed or unknown id and switches a stored one', () => {
  const { store } = makeStore();
  const { a, b } = seed(store);
  const { handlers, ipcMain } = fakeIpc();
  registerClaudeAccountsIpc({ ipcMain, accounts: store, openTokenTab: () => {} });
  const makeActive = handlers.get('claudeAccounts:make-active');
  for (const bad of [null, undefined, 42, '', '../x', 'A', { id: b }, 'a'.repeat(21), 'unknown1']) {
    assert.deepEqual(makeActive({}, bad), { ok: false, error: 'notFound' }, String(bad));
  }
  assert.equal(store.active().id, a);
  assert.deepEqual(makeActive({}, b), { ok: true });
  assert.equal(store.active().id, b);
});

test('IPC set-reserve: validates id and caps in main before the store sees them', () => {
  const seen = [];
  const accounts = { list: () => ({ accounts: [] }), setReserve: (id, r) => { seen.push([id, r]); return { ok: true }; } };
  const { handlers, ipcMain } = fakeIpc();
  registerClaudeAccountsIpc({ ipcMain, accounts, openTokenTab: () => {} });
  const setReserve = handlers.get('claudeAccounts:set-reserve');
  assert.deepEqual(setReserve({}, null), { ok: false, error: 'notFound' });
  assert.deepEqual(setReserve({}, { id: '../x', fiveHour: 50 }), { ok: false, error: 'notFound' });
  assert.deepEqual(setReserve({}, { id: 'gmail', fiveHour: 0 }), { ok: false, error: 'badReserve' });
  assert.deepEqual(setReserve({}, { id: 'gmail', weekly: '101' }), { ok: false, error: 'badReserve' });
  assert.deepEqual(seen, []);
  assert.deepEqual(setReserve({}, { id: 'gmail', fiveHour: '50', weekly: '' }), { ok: true });
  assert.deepEqual(seen, [['gmail', { fiveHour: 50 }]]);
});

// ---- Usage panel (renderer helpers) ------------------------------------------

test('switchToAccount calls the switch with the row\'s account id', async () => {
  const calls = [];
  const api = { makeClaudeAccountActive: async (id) => { calls.push(id); return { ok: true }; } };
  assert.deepEqual(await switchToAccount('onet', api), { ok: true });
  assert.deepEqual(calls, ['onet']);
  assert.deepEqual(await switchToAccount('onet', {}), { ok: false, error: 'unavailable' });
  const throwing = { makeClaudeAccountActive: async () => { throw new Error('ipc'); } };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await switchToAccount('onet', throwing), { ok: false, error: 'failed' });
  } finally {
    console.error = origError;
  }
});

test('isSwitchable: stored, non-active accounts only (not the agy Google row)', () => {
  assert.equal(isSwitchable({ accountId: 'onet', active: false }), true);
  assert.equal(isSwitchable({ accountId: 'gmail', active: true }), false);
  assert.equal(isSwitchable({ label: 'me@gmail.com', active: false }), false);
  assert.equal(isSwitchable(null), false);
});

test('reserveCapFor + rowDimState: the cap marks the row and dims it once reached', () => {
  const account = { accountId: 'o', reserve: { fiveHour: 50, weekly: null } };
  const five = { window: '5h', percentUsed: 50, resetsAt: iso(START + HOUR) };
  const week = { window: 'weekly', percentUsed: 90, resetsAt: iso(START + 9 * HOUR) };
  assert.equal(reserveCapFor(account, five), 50);
  assert.equal(reserveCapFor(account, week), null);
  assert.equal(reserveCapFor({ reserve: { fiveHour: 500 } }, five), null);
  assert.equal(reserveCapFor(null, five), null);
  assert.deepEqual(rowDimState({ account, limit: five, blockedBy: null }, 2),
    { kind: 'reserve', resetsAt: five.resetsAt, sole: false, cap: 50 });
  assert.equal(rowDimState({ account, limit: { ...five, percentUsed: 49 }, blockedBy: null }, 2), null);
  // A spent limit keeps its own state - the cap does not replace it.
  assert.equal(rowDimState({ account, limit: { ...five, percentUsed: 100 }, blockedBy: null }, 1).kind, 'exhausted');
});
