// Compact usage tile (src/renderer/modules/usage.js): the pure helpers behind
// the window-grouped grid - row grouping, bar level, short labels - and the
// pl/en strings they use.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  groupUsageRows,
  blockingWeekly,
  usageLevel,
  windowShortLabel,
  limitLabel,
  shortMessageKey,
  accountMessageKey,
} = require('../src/renderer/modules/usage.js');

const ROOT = path.join(__dirname, '..');
const five = (pct) => ({ window: '5h', label: '5-hour window', percentUsed: pct });
const week = (pct) => ({ window: 'weekly', label: 'Weekly limit', percentUsed: pct });
const acct = (label, over = {}) => ({ label, status: 'ok', active: false, limits: [], ...over });
const echo = (key) => key;

test('two accounts x two windows: 5h group then weekly group, 4 rows, no notices', () => {
  const gmail = acct('gmail', { active: true, limits: [week(71), five(62)] });
  const onet = acct('onet', { limits: [five(18), week(29)] });
  const { groups, notices } = groupUsageRows([gmail, onet].map((a) => ({ account: a, limits: a.limits })));
  assert.deepEqual(groups.map((g) => g.key), ['5h', 'weekly']);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), 4);
  assert.deepEqual(groups[0].rows.map((r) => [r.account.label, r.limit.percentUsed]), [['gmail', 62], ['onet', 18]]);
  assert.deepEqual(groups[1].rows.map((r) => [r.account.label, r.limit.percentUsed]), [['gmail', 71], ['onet', 29]]);
  assert.deepEqual(notices, []);
});

test('an account without bars becomes one notice, keyed by accountMessageKey', () => {
  const ok = acct('gmail', { limits: [five(10), week(20)] });
  const broken = acct('onet', { status: 'reconnect' });
  const { groups, notices } = groupUsageRows([ok, broken].map((a) => ({ account: a, limits: a.limits })));
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.rows.length === 1 && g.rows[0].account === ok));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].account, broken);
  assert.equal(notices[0].key, accountMessageKey(broken));
});

test('stale bars with a reconnect status keep their rows and add one notice', () => {
  const stale = acct('onet', { status: 'reconnect', limits: [five(50)] });
  const { groups, notices } = groupUsageRows([{ account: stale, limits: stale.limits }]);
  assert.equal(groups[0].rows.length, 1);
  assert.deepEqual(notices.map((n) => n.key), ['usage.account.reconnect']);
});

test('single source without an account: one row per window, never a notice', () => {
  const { groups, notices } = groupUsageRows([{ account: null, limits: [week(5), five(9)] }]);
  assert.deepEqual(groups.map((g) => [g.key, g.rows.length, g.rows[0].account]), [['5h', 1, null], ['weekly', 1, null]]);
  assert.deepEqual(notices, []);
});

test('custom windows follow the shared ones, split by label, in arrival order', () => {
  const limits = [
    { window: 'custom', label: 'MCP', percentUsed: 1 },
    week(2),
    { window: 'custom', label: 'Opus', percentUsed: 3 },
    { window: 'balance', label: 'Balance', valueText: '$4.20' },
    five(5),
  ];
  const { groups } = groupUsageRows([{ account: null, limits }]);
  assert.deepEqual(groups.map((g) => g.key), ['5h', 'weekly', 'custom:MCP', 'custom:Opus', 'balance:Balance']);
});

test('malformed input is skipped, not thrown on', () => {
  assert.deepEqual(groupUsageRows(undefined), { groups: [], notices: [] });
  const { groups } = groupUsageRows([null, 'x', { account: null, limits: [null, { window: '5h' }, five(1)] }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 1);
});

test('a spent week marks only the 5h row of that account as blocked', () => {
  const gmail = acct('gmail', { active: true, limits: [five(38), week(100)] });
  const onet = acct('onet', { limits: [five(18), week(29)] });
  const { groups } = groupUsageRows([gmail, onet].map((a) => ({ account: a, limits: a.limits })));
  const [fiveGroup, weekGroup] = groups;
  assert.equal(fiveGroup.rows[0].blockedBy.percentUsed, 100, 'gmail 5h is blocked');
  assert.equal(fiveGroup.rows[1].blockedBy, null, 'onet 5h is not');
  assert.ok(weekGroup.rows.every((r) => r.blockedBy === null), 'weekly rows are never dimmed');
});

test('blockingWeekly: only a weekly at 100% blocks, only a 5h row', () => {
  assert.equal(blockingWeekly(five(10), [five(10), week(99)]), null);
  assert.equal(blockingWeekly(five(10), [five(10), week(100)]).window, 'weekly');
  assert.equal(blockingWeekly(five(10), [week(130)]).percentUsed, 130);
  assert.equal(blockingWeekly(week(100), [week(100)]), null);
  assert.equal(blockingWeekly(five(10), [{ window: 'weekly', label: 'Opus', percentUsed: 100 }]), null, 'a model sub-limit does not block');
  assert.equal(blockingWeekly(five(10), undefined), null);
});

test('usageLevel: neutral below 70, warn from 70, bad from 90', () => {
  assert.equal(usageLevel(0), 'good');
  assert.equal(usageLevel(69), 'good');
  assert.equal(usageLevel(70), 'warn');
  assert.equal(usageLevel(89), 'warn');
  assert.equal(usageLevel(90), 'bad');
  assert.equal(usageLevel(100), 'bad');
});

test('windowShortLabel: short key for shared windows, provider label otherwise', () => {
  assert.equal(windowShortLabel(five(1), echo), 'usage.window.short.5h');
  assert.equal(windowShortLabel(week(1), echo), 'usage.window.short.week');
  assert.equal(limitLabel(week(1), echo), 'usage.window.week');
  assert.equal(windowShortLabel({ window: 'custom', label: 'Opus' }, echo), 'Opus');
});

test('shortMessageKey covers every key accountMessageKey can return', () => {
  const statuses = [
    { status: 'reconnect' }, { status: 'reconnect', main: true }, { status: 'unconnected' },
    { status: 'error' }, { status: 'loading' },
  ];
  for (const a of statuses) {
    const key = accountMessageKey({ ...a, limits: [] });
    assert.notEqual(shortMessageKey(key), key, `no short form for ${key}`);
  }
});

test('new usage strings exist in pl and en, pl without diacritics', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  const pl = src.slice(0, enAt);
  const en = src.slice(enAt);
  const keys = [
    'usage.window.short.5h', 'usage.window.short.day', 'usage.window.short.week', 'usage.window.short.month',
    'usage.resetNow', 'usage.blockedByWeekly', 'usage.account.openSettings', 'usage.account.short.reconnect',
    'usage.account.short.reconnectMain', 'usage.account.short.unconnected',
    'usage.account.short.unavailable', 'usage.account.short.loading',
  ];
  for (const key of keys) {
    const plLine = pl.split('\n').find((l) => l.includes(`'${key}':`));
    assert.ok(plLine, `pl is missing ${key}`);
    assert.ok(en.includes(`'${key}':`), `en is missing ${key}`);
    assert.ok(!/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(plLine), `pl ${key} has diacritics`);
  }
});

test('the Settings anchor the notice arrow opens exists in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(html.includes('id="claude-accounts-section"'));
  assert.ok(!html.includes('id="usage-updated"'), 'the visible "updated" line is gone');
});
