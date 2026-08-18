// Tests for the pure formatting behind the Ctrl+G quick-menu
// (gitquick-format.js). Zero DOM - the menu/keybinding wiring in gitquick.js
// itself queries `document.getElementById` at module scope (same as
// palette.js/termcustom.js) and is left to the manual checklist, same as
// those two.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeCommand,
  summarizeResult,
  buildMirrorText,
} = require('../src/renderer/modules/gitquick-format.js');

// Pass-through stub: returns the key itself (with params inlined), so an
// assertion can check WHICH key was picked without needing real i18n.js.
const t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);

// ---- describeCommand --------------------------------------------------------

test('describeCommand builds the add+commit line with the message quoted', () => {
  assert.equal(describeCommand('commit', 'fix: typo'), 'git add -A && git commit -m "fix: typo"');
});

test('describeCommand for push/fetch/status ignores the message argument', () => {
  assert.equal(describeCommand('push'), 'git push');
  assert.equal(describeCommand('fetch'), 'git fetch --all --prune');
  assert.equal(describeCommand('status'), 'git status');
});

test('describeCommand returns empty string for an unknown action', () => {
  assert.equal(describeCommand('rebase'), '');
});

// ---- summarizeResult ---------------------------------------------------------

test('summarizeResult reports noRepo when the session has no cwd', () => {
  const out = summarizeResult('commit', { ok: false, error: 'noSession' }, t);
  assert.deepEqual(out, { ok: false, text: 'gitquick.result.noRepo' });
});

test('summarizeResult reports noRepo when the IPC result itself is missing', () => {
  assert.deepEqual(summarizeResult('push', null, t), { ok: false, text: 'gitquick.result.noRepo' });
});

test('summarizeResult maps commit/push/fetch ok and fail to their own keys', () => {
  assert.equal(summarizeResult('commit', { ok: true }, t).text, 'gitquick.result.commitOk');
  assert.equal(summarizeResult('commit', { ok: false }, t).text, 'gitquick.result.commitFail');
  assert.equal(summarizeResult('push', { ok: true }, t).text, 'gitquick.result.pushOk');
  assert.equal(summarizeResult('push', { ok: false }, t).text, 'gitquick.result.pushFail');
  assert.equal(summarizeResult('fetch', { ok: true }, t).text, 'gitquick.result.fetchOk');
  assert.equal(summarizeResult('fetch', { ok: false }, t).text, 'gitquick.result.fetchFail');
});

test('summarizeResult ok flag mirrors the IPC result, not just presence of a value', () => {
  assert.equal(summarizeResult('push', { ok: false, error: 'pushFailed', output: 'rejected' }, t).ok, false);
});

const status = (over) => ({
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: 0,
  changed: 0,
  untracked: 0,
  conflicts: 0,
  ...over,
});

test('summarizeResult status formats a clean repo as just the branch', () => {
  const res = { ok: true, repo: { error: '', status: status() } };
  assert.deepEqual(summarizeResult('status', res, t), { ok: true, text: 'main' });
});

test('summarizeResult status adds ahead/behind/dirty/conflict glyphs only when non-zero', () => {
  const res = { ok: true, repo: { error: '', status: status({ ahead: 2, behind: 1, changed: 3, conflicts: 1 }) } };
  assert.equal(summarizeResult('status', res, t).text, 'main ↓1 ↑2 ●3 !1');
});

test('summarizeResult status treats staged+changed+untracked as one combined dirty count', () => {
  const res = { ok: true, repo: { error: '', status: status({ staged: 1, changed: 1, untracked: 1 }) } };
  assert.equal(summarizeResult('status', res, t).text, 'main ●3');
});

test('summarizeResult status surfaces the repo error via the existing git.error.* keys', () => {
  const res = { ok: true, repo: { error: 'notARepo', status: null } };
  assert.deepEqual(summarizeResult('status', res, t), { ok: false, text: 'git.error.notARepo' });
});

test('summarizeResult status with no repo object at all falls back to noRepo', () => {
  assert.deepEqual(summarizeResult('status', { ok: true, repo: null }, t), { ok: false, text: 'gitquick.result.noRepo' });
});

// ---- buildMirrorText ---------------------------------------------------------

test('buildMirrorText returns null when there is no session to act on', () => {
  assert.equal(buildMirrorText('commit', 'msg', { ok: false, error: 'noSession' }), null);
});

test('buildMirrorText shows the command and CRLF-joins git\'s own output', () => {
  const res = { ok: true, output: 'main a1b2c3d] quick save\n 2 files changed' };
  const out = buildMirrorText('commit', 'quick save', res);
  assert.equal(out, '\r\n$ git add -A && git commit -m "quick save"\r\nmain a1b2c3d] quick save\r\n 2 files changed\r\n');
});

test('buildMirrorText omits the output block entirely when there is none', () => {
  const out = buildMirrorText('push', '', { ok: true, output: '' });
  assert.equal(out, '\r\n$ git push\r\n');
});

test('buildMirrorText trims surrounding whitespace from git\'s output before joining', () => {
  const out = buildMirrorText('fetch', '', { ok: true, output: '\n  Fetching origin  \n\n' });
  assert.equal(out, '\r\n$ git fetch --all --prune\r\nFetching origin\r\n');
});

test('buildMirrorText for status never appends output, even if the field is set', () => {
  const out = buildMirrorText('status', '', { ok: true, output: 'should not appear', repo: {} });
  assert.equal(out, '\r\n$ git status\r\n');
});
