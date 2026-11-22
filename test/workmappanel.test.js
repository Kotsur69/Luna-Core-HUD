// ============================================================================
// Work map side panel (src/renderer/modules/workmapPanel.js): the live
// ticker's formatting, which session the switcher shows, and what the
// inspector says about a station or a satellite. Pure helpers only; t() is a
// stub that echoes the key and its parameters.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/renderer/modules/workmapPanel.js');

globalThis.window = { i18n: { t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) } };

const call = (callId, extra = {}) => ({ callId, station: 'files', tool: 'Read', detail: '', file: '', added: 0, removed: 0, status: 'ok', at: 1, ...extra });

// --- ticker --------------------------------------------------------------------------

test('tickerRows lists the newest call first and stops at TICKER_ROWS', () => {
  const recent = [];
  for (let i = 0; i < P.TICKER_ROWS + 4; i += 1) recent.push(call(`c${i}`));
  const rows = P.tickerRows(recent);
  assert.equal(rows.length, P.TICKER_ROWS);
  assert.equal(rows[0].key, `c${P.TICKER_ROWS + 3}`);
  assert.equal(P.tickerRows(recent, 3).length, 3);
});

test('a ticker row says tool, detail, +/- lines and outcome', () => {
  const [row] = P.tickerRows([call('e', { tool: 'Edit', file: 'C:\\repo\\src\\workmap.js', added: 12, removed: 3, status: 'ok' })]);
  assert.deepEqual(
    { tool: row.tool, detail: row.detail, lines: row.lines, status: row.status, full: row.fullDetail },
    { tool: 'Edit', detail: 'workmap.js', lines: '+12 -3', status: 'ok', full: 'C:\\repo\\src\\workmap.js' },
  );
  const [shell] = P.tickerRows([call('s', { station: 'shell', tool: 'Shell', detail: 'npm test', status: 'running' })]);
  assert.equal(shell.detail, 'npm test');
  assert.equal(shell.lines, '');
  assert.equal(shell.status, 'running');
});

test('a long detail is cut for the ticker; the full one stays for its tooltip', () => {
  const long = 'git log --oneline --decorate --graph --all --since=yesterday';
  const [row] = P.tickerRows([call('g', { tool: 'Shell', detail: long })]);
  assert.ok(row.detail.length < long.length);
  assert.ok(row.detail.endsWith('…'));
  assert.equal(row.fullDetail, long);
});

test('tickerRows reads junk as nothing and an unknown status as running', () => {
  assert.deepEqual(P.tickerRows(null), []);
  assert.deepEqual(P.tickerRows([null, 7]), []);
  assert.equal(P.tickerRows([call('x', { status: 'weird' })])[0].status, 'running');
  assert.equal(P.tickerRows([call('y', { tool: '' })])[0].tool, '?');
});

test('stationRecent keeps one station\'s calls, newest first', () => {
  const recent = [call('a'), call('b', { station: 'shell' }), call('c'), call('d', { station: 'shell' })];
  assert.deepEqual(P.stationRecent(recent, 'shell').map((r) => r.key), ['d', 'b']);
  assert.deepEqual(P.stationRecent(recent, 'files', 1).map((r) => r.key), ['c']);
  assert.deepEqual(P.stationRecent(undefined, 'files'), []);
});

// --- switcher ------------------------------------------------------------------------------

test('resolveViewed shows the pinned session while it is open, else the active tab', () => {
  const open = new Set(['a', 'b']);
  assert.equal(P.resolveViewed('', 'a', open), 'a');
  assert.equal(P.resolveViewed('b', 'a', open), 'b');
  assert.equal(P.resolveViewed('gone', 'a', open), 'a');
  assert.equal(P.resolveViewed(null, null, open), null);
  assert.equal(P.resolveViewed('b', null, null), null);
});

// --- inspector -------------------------------------------------------------------------------

test('agoText is coarse and refuses junk', () => {
  assert.equal(P.agoText(12_400), '12 s');
  assert.equal(P.agoText(3 * 60_000 + 5), '3 min');
  assert.equal(P.agoText(2 * 3_600_000), '2 h');
  assert.equal(P.agoText(-1), '');
  assert.equal(P.agoText(NaN), '');
});

test('the station view shows counts, extras, its satellites and its own last calls', () => {
  const st = { total: 5, inFlight: 1, errors: 1, lastError: { message: 'denied' } };
  const recent = [call('a', { tool: 'Read', file: 'C:/r/a.js' }), call('b', { station: 'shell', tool: 'Shell', detail: 'ls' })];
  const view = P.stationView('Files', st, ['extra'], recent, 'files', [{ kind: 'file', label: 'C:/r/a.js' }]);
  assert.equal(view.title, 'Files');
  assert.match(view.lines[0], /"calls":5/);
  assert.ok(view.lines.includes('extra'));
  assert.ok(view.lines.some((l) => l.includes('denied')));
  assert.ok(view.lines.some((l) => l.includes('a.js') && l.startsWith('lm.wm.inspect.sats')));
  assert.equal(view.list.length, 1);
  assert.match(view.list[0], /^Read · a\.js · lm\.wm\.status\.ok$/);
});

test('a quiet station says so', () => {
  const view = P.stationView('Skills', { total: 0, inFlight: 0, errors: 0, lastError: null }, [], [], 'skills', []);
  assert.deepEqual(view.list, ['lm.wm.inspect.none']);
});

test('the satellite view of a process names its command, ports and state; a gone item says so', () => {
  const proc = { key: 'pid:10', kind: 'process', pid: 10, name: 'node.exe', label: 'node server.js', ports: [3000], alive: false, lastAt: 1000 };
  const view = P.satelliteView(proc, 1000 + 75_000);
  assert.equal(view.title, 'node server.js');
  assert.equal(view.kind, 'lm.wm.sat.process');
  assert.ok(view.lines.includes('node server.js (pid 10)'));
  assert.ok(view.lines.some((l) => l.includes('3000')));
  assert.ok(view.lines.includes('lm.wm.sat.gone'));
  assert.ok(view.lines.some((l) => l.includes('1 min')));
  assert.equal(P.satelliteView(null, 0).title, 'lm.wm.inspect.gone');
});

test('the satellite view of a subagent counts its calls and failures', () => {
  const agent = { key: 'Explore', kind: 'agent', label: 'Explore', calls: 3, added: 0, removed: 0, failed: 1, lastAt: 50, alive: undefined };
  const view = P.satelliteView(agent, 50);
  assert.equal(view.title, 'Explore');
  assert.match(view.lines[0], /lm\.wm\.sat\.calls \{"n":3\}/);
  assert.match(view.lines[0], /lm\.wm\.failed \{"n":1\}/);
});
