// Per-account usage beyond main: the phone snapshot's `accounts` rows
// (src/usagesnapshot.js), the HUD tile's pure helpers
// (src/renderer/modules/usage.js) and the pl/en strings both use.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { usageSnapshot, parseUsagePeer, newestUsage } = require('../src/usagesnapshot');
const { visibleAccounts, accountMessageKey } = require('../src/renderer/modules/usage.js');

const ROOT = path.join(__dirname, '..');
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12);
const iso = (ms) => new Date(ms).toISOString();
const limits = (five, week) => [
  { window: '5h', percentUsed: five, resetsAt: iso(NOW + 2 * HOUR) },
  { window: 'weekly', percentUsed: week, resetsAt: iso(NOW + 72 * HOUR) },
];
const read = (over = {}) => ({
  providerId: 'claude',
  status: 'ok',
  isFallback: false,
  updatedAt: NOW - 1000,
  limits: limits(42, 17),
  accounts: [
    { accountId: 'g', label: 'Gmail', active: true, status: 'ok', limits: limits(42, 17) },
    { accountId: 'o', label: 'Onet', active: false, status: 'ok', limits: limits(90, 60) },
    { accountId: 'x', label: 'Spare', active: false, status: 'reconnect', limits: [] },
  ],
  ...over,
});
const row = (machine, data) => ({ machine, data });

// ---- snapshot ------------------------------------------------------------

test('snapshot carries one row per account with a healthy read', () => {
  const s = usageSnapshot(read(), NOW);
  assert.equal(s.v, 1);
  assert.deepEqual(s.fiveHour, { pct: 42, resetsAt: NOW + 2 * HOUR });
  assert.deepEqual(s.accounts, [
    { label: 'Gmail', active: true, fiveHour: { pct: 42, resetsAt: NOW + 2 * HOUR }, sevenDay: { pct: 17, resetsAt: NOW + 72 * HOUR } },
    { label: 'Onet', active: false, fiveHour: { pct: 90, resetsAt: NOW + 2 * HOUR }, sevenDay: { pct: 60, resetsAt: NOW + 72 * HOUR } },
  ]);
  const p = parseUsagePeer(row('PC', s), NOW);
  assert.deepEqual(p.accounts, s.accounts);
});

test('a snapshot without accounts is the old shape exactly', () => {
  const s = usageSnapshot(read({ accounts: undefined }), NOW);
  assert.deepEqual(Object.keys(s), ['v', 'at', 'fiveHour', 'sevenDay']);
  assert.deepEqual(Object.keys(parseUsagePeer(row('PC', s), NOW)), ['machine', 'at', 'fiveHour', 'sevenDay']);
});

test('an old reader still gets the top-level windows from a new row', () => {
  const s = usageSnapshot(read(), NOW);
  // What an old reader looks at: v, at, fiveHour, sevenDay - all still there.
  const { accounts: _rows, ...old } = s;
  assert.deepEqual(parseUsagePeer(row('PC', old), NOW).fiveHour, parseUsagePeer(row('PC', s), NOW).fiveHour);
  assert.equal(newestUsage([row('PC', s)], NOW).sevenDay.pct, 17);
});

test('main read failed: the top level falls back to the active account', () => {
  const s = usageSnapshot(read({ status: 'error', limits: [] }), NOW);
  assert.equal(s.fiveHour.pct, 42);
  const noActive = read({ status: 'error', limits: [] });
  noActive.accounts = noActive.accounts.map((a) => ({ ...a, active: false }));
  assert.equal(usageSnapshot(noActive, NOW).fiveHour.pct, 42, 'then the first account with a read');
  assert.equal(usageSnapshot(read({ status: 'error', limits: [], accounts: [] }), NOW), null);
});

test('a malformed account entry drops only itself, not the row', () => {
  const s = usageSnapshot(read(), NOW);
  const bell = String.fromCharCode(7);
  const bad = {
    ...s,
    accounts: [
      ...s.accounts,
      { label: '', active: true, fiveHour: { pct: 1, resetsAt: null } },
      { label: `Evil${bell}`, fiveHour: { pct: 1, resetsAt: null } },
      { label: 'Odd', fiveHour: { pct: '50' } },
      { label: 'Far', fiveHour: { pct: 5, resetsAt: NOW + 40 * 24 * HOUR } },
      { label: 'Empty', fiveHour: null, sevenDay: null },
      'nope',
    ],
  };
  const p = parseUsagePeer(row('PC', bad), NOW);
  assert.ok(p);
  assert.deepEqual(p.accounts.map((a) => a.label), ['Gmail', 'Onet']);
  assert.deepEqual(Object.keys(parseUsagePeer(row('PC', { ...s, accounts: 'x' }), NOW)), ['machine', 'at', 'fiveHour', 'sevenDay']);
});

// ---- HUD tile helpers ----------------------------------------------------

test('visibleAccounts: none connected -> the tile stays the single read', () => {
  assert.deepEqual(visibleAccounts([{ status: 'unconnected' }, { status: 'unconnected' }]), []);
  assert.deepEqual(visibleAccounts(undefined), []);
  const list = [{ status: 'ok' }, { status: 'unconnected' }];
  assert.deepEqual(visibleAccounts(list), list);
});

test('accountMessageKey: reconnect, unconnected, loading and stale bars', () => {
  assert.equal(accountMessageKey({ status: 'reconnect', limits: [] }), 'usage.account.reconnect');
  assert.equal(accountMessageKey({ status: 'reconnect', main: true, limits: [] }), 'usage.account.reconnectMain');
  assert.equal(accountMessageKey({ status: 'unconnected', limits: [] }), 'usage.account.unconnected');
  assert.equal(accountMessageKey({ status: 'loading', limits: [] }), 'usage.loading');
  assert.equal(accountMessageKey({ status: 'error', limits: [] }), 'usage.unavailable');
  assert.equal(accountMessageKey({ status: 'error', limits: [{ percentUsed: 1 }] }), null);
  assert.equal(accountMessageKey({ status: 'ok', limits: [{ percentUsed: 1 }] }), null);
});

// ---- strings -------------------------------------------------------------

test('every usage.account.* / accounts.usage.* key exists in pl and en, pl without diacritics', () => {
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  assert.ok(enAt > 0);
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);
  const used = new Set();
  for (const file of ['src/renderer/modules/usage.js', 'src/renderer/modules/claudeaccountsettings.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/'((?:usage\.account|accounts\.usage)\.[a-zA-Z.]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 15, `expected the new keys to be used, saw ${used.size}`);
  const diacritics = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
  for (const key of used) {
    const plLine = pl.split('\n').find((l) => l.includes(`'${key}':`));
    assert.ok(plLine, `pl is missing ${key}`);
    assert.ok(en.includes(`'${key}':`), `en is missing ${key}`);
    assert.ok(!diacritics.test(plLine), `pl ${key} has diacritics`);
  }
  const mobile = fs.readFileSync(path.join(ROOT, 'mobile/src/i18n.js'), 'utf8');
  assert.equal(mobile.split('usageActive:').length - 1, 2, 'mobile i18n needs usageActive in both languages');
});
