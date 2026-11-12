// ============================================================================
// Live map (Ctrl+Shift+G): pure helpers + the i18n drift guard
// ----------------------------------------------------------------------------
// liveMapHelpers.js decides what the God Mode tab shows without a document;
// these tests pin that. The last tests scan every live-map module and its
// index.html markup for i18n keys and require each one in BOTH languages,
// so a string can never render as a raw key.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('../src/renderer/modules/liveMapHelpers.js');
const { buildGraph } = require('../src/renderer/modules/orchestraGraphModel.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = 1_800_000_000_000;
const pkg = (id, extra = {}) => ({ id, title: `T ${id}`, state: 'pending', dependsOn: [], ...extra });
const runOf = (packages, extra = {}) => ({ id: 'plan', projectId: 'p', packages, ...extra });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

test('readPref / writePref: remembered value, junk and throwing storage fall back', () => {
  const store = memoryStorage({ [H.STORAGE_TAB]: 'sessions', [H.STORAGE_DIR]: 'diagonal' });
  assert.equal(H.readPref(store, H.STORAGE_TAB, H.TAB_KEYS, H.DEFAULT_TAB), 'sessions');
  assert.equal(H.readPref(store, H.STORAGE_DIR, H.DIRECTIONS, 'LR'), 'LR');
  assert.equal(H.readPref(null, H.STORAGE_TAB, H.TAB_KEYS, H.DEFAULT_TAB), 'godmode');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(H.readPref(broken, H.STORAGE_TAB, H.TAB_KEYS, H.DEFAULT_TAB), 'godmode');
  assert.equal(H.writePref(broken, H.STORAGE_TAB, 'godmode'), false);
  assert.equal(H.writePref(null, H.STORAGE_TAB, 'godmode'), false);
  assert.equal(H.writePref(store, H.STORAGE_DIR, 'TB'), true);
  assert.equal(store.data[H.STORAGE_DIR], 'TB');
});

test('tabs: order, default and Arrow / Home / End navigation', () => {
  assert.deepEqual(H.TAB_KEYS, ['sessions', 'godmode', 'lunaswork']);
  assert.equal(H.nextTab('ArrowRight', 'godmode'), 'lunaswork');
  assert.equal(H.nextTab('ArrowRight', 'lunaswork'), 'sessions');
  assert.equal(H.nextTab('ArrowLeft', 'sessions'), 'lunaswork');
  assert.equal(H.nextTab('Home', 'lunaswork'), 'sessions');
  assert.equal(H.nextTab('End', 'sessions'), 'lunaswork');
  assert.equal(H.nextTab('a', 'sessions'), null);
});

test('clampZoom and elapsedLabel', () => {
  assert.equal(H.clampZoom(10), H.ZOOM_MAX);
  assert.equal(H.clampZoom(0.01), H.ZOOM_MIN);
  assert.equal(H.clampZoom(NaN), 1);
  assert.equal(H.clampZoom(1.5), 1.5);
  assert.equal(H.elapsedLabel(null), null);
  assert.equal(H.elapsedLabel(-5), null);
  assert.deepEqual(H.elapsedLabel(45_000), { key: 'lm.elapsed.s', params: { s: 45 } });
  assert.deepEqual(H.elapsedLabel(12 * 60_000), { key: 'lm.elapsed.m', params: { m: 12 } });
  assert.deepEqual(H.elapsedLabel(65 * 60_000), { key: 'lm.elapsed.h', params: { h: 1, m: '05' } });
});

test('truncate and matchesFilter', () => {
  assert.equal(H.truncate('abcdef', 4), 'abc…');
  assert.equal(H.truncate('abc', 4), 'abc');
  assert.equal(H.truncate(null, 4), '');
  const node = { id: 'auth-api', title: 'Login endpoint', state: 'failed', stateKey: 'failed', visual: 'failed' };
  assert.equal(H.matchesFilter(node, ''), true);
  assert.equal(H.matchesFilter(node, '  LOGIN '), true);
  assert.equal(H.matchesFilter(node, 'auth failed'), true);
  assert.equal(H.matchesFilter(node, 'auth pushed'), false);
  assert.equal(H.matchesFilter(node, 'blad', 'blad'), true);
});

test('graphStatus: every state of the God Mode tab', () => {
  const st = (view, opts) => H.graphStatus(view, buildGraph(view, { now: NOW }), opts);
  assert.equal(st(null, { loading: true }).kind, 'loading');
  assert.equal(st(null).kind, 'noRun');
  assert.equal(st({ id: 'x' }).kind, 'malformed');
  assert.equal(st(runOf([])).kind, 'noPackages');
  assert.deepEqual(st(runOf([pkg('a')])), { kind: 'graph', banner: null, single: true });
  assert.equal(st(runOf([pkg('a', { state: 'pushed' }), pkg('b', { state: 'pushed' })])).banner, 'done');
  assert.equal(st(runOf([pkg('a', { state: 'failed' }), pkg('b', { dependsOn: ['a'] })])).banner, 'failed');
  // Still running: no failed banner yet.
  assert.equal(st(runOf([pkg('a', { state: 'failed' }), pkg('b', { state: 'launched', startedAt: NOW })])).banner, null);
  assert.equal(st(runOf([pkg('a')], { killed: true })).banner, 'killed');
  const big = [];
  for (let i = 0; i <= H.GRAPH_SUMMARY_LIMIT; i += 1) big.push(pkg(`p${i}`));
  assert.equal(st(runOf(big)).kind, 'summary');
  big.pop();
  assert.equal(st(runOf(big)).kind, 'graph');
});

test('doneSummary counts and wall time', () => {
  const view = runOf([
    pkg('a', { state: 'pushed', merged: true, finishedAt: NOW + 60_000 }),
    pkg('b', { state: 'pushed', finishedAt: NOW + 120_000 }),
  ], { runStartedAt: NOW });
  assert.deepEqual(H.doneSummary(view, buildGraph(view, { now: NOW })), { total: 2, pushed: 2, merged: 1, wallMs: 120_000 });
  const noStart = runOf([pkg('a', { state: 'pushed' })]);
  assert.equal(H.doneSummary(noStart, buildGraph(noStart)).wallMs, null);
});

test('summaryLists: ordered counts and the failed / blocked / active lists', () => {
  const packages = [
    pkg('f', { state: 'failed' }),
    pkg('b', { dependsOn: ['f'] }),
    pkg('r', { state: 'launched', startedAt: NOW }),
    pkg('d', { state: 'pushed' }),
    pkg('w', { dependsOn: ['ghost'] }),
  ];
  for (let i = 0; i < 35; i += 1) packages.push(pkg(`x${i}`, { state: 'failed' }));
  const lists = H.summaryLists(buildGraph(runOf(packages), { now: NOW }));
  assert.deepEqual(lists.counts.map((c) => c.key), ['launched', 'failed', 'pending', 'pushed']);
  assert.equal(lists.counts.find((c) => c.key === 'failed').n, 36);
  assert.equal(lists.failed.items.length, 30);
  assert.equal(lists.failed.more, 6);
  assert.deepEqual(lists.blocked.items.map((i) => i.id), ['b']);
  assert.deepEqual(lists.active.items.map((i) => i.id), ['r']);
});

test('runChips drops the "plan this project" chip', () => {
  assert.deepEqual(H.runChips([{ projectId: 'a', state: 'running' }, { projectId: 'b', state: 'none' }, null]), [{ projectId: 'a', state: 'running' }]);
  assert.deepEqual(H.runChips(undefined), []);
});

// --- i18n drift guard ---------------------------------------------------------
const I18N = read('src/renderer/i18n.js');
const EN_AT = I18N.indexOf('\n  en: {');
const PL_SRC = I18N.slice(0, EN_AT);
const EN_SRC = I18N.slice(EN_AT);
const has = (src, key) => src.includes(`'${key}':`);

const LIVE_MAP_FILES = [
  'src/renderer/modules/liveMap.js',
  'src/renderer/modules/liveMapGodMode.js',
  'src/renderer/modules/liveMapToolbar.js',
  'src/renderer/modules/liveMapDetails.js',
  'src/renderer/modules/liveMapHelpers.js',
  'src/renderer/modules/orchestraGraphView.js',
];

function usedKeys() {
  const keys = new Set();
  for (const file of LIVE_MAP_FILES) {
    for (const m of read(file).matchAll(/'((?:lm|orch|shortcuts)\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
  }
  const html = read('src/renderer/index.html');
  const start = html.indexOf('<div id="livemap"');
  const block = html.slice(start, html.indexOf('Life dashboard (Ctrl+Shift+N)', start));
  for (const m of block.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1]);
  return [...keys];
}

test('every live-map i18n key exists in pl and en', () => {
  const keys = usedKeys();
  assert.ok(keys.length > 40, `found only ${keys.length} keys`);
  for (const key of keys) {
    assert.ok(has(PL_SRC, key), `missing pl: ${key}`);
    assert.ok(has(EN_SRC, key), `missing en: ${key}`);
  }
});

test('every lm.* key is defined in both languages (no one-sided entries)', () => {
  const pl = [...PL_SRC.matchAll(/'(lm\.[A-Za-z0-9_.]+)':/g)].map((m) => m[1]).sort();
  const en = [...EN_SRC.matchAll(/'(lm\.[A-Za-z0-9_.]+)':/g)].map((m) => m[1]).sort();
  assert.deepEqual(pl, en);
  // Dynamic keys built at runtime.
  for (const key of ['lm.elapsed.s', 'lm.elapsed.m', 'lm.elapsed.h', 'lm.state.loading', 'lm.state.noRun', 'lm.state.malformed', 'lm.state.noPackages']) {
    assert.ok(pl.includes(key), key);
  }
});

test('Polish live-map strings carry no diacritics (repo convention)', () => {
  const lines = PL_SRC.split('\n').filter((l) => /^\s*'lm\./.test(l));
  for (const line of lines) assert.doesNotMatch(line, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, line);
});

test('the live map is listed in the Ctrl+/ panel and Ctrl+G leaves the shifted chord alone', () => {
  const { flattenShortcuts } = require('../src/renderer/modules/shortcuts.js');
  const row = flattenShortcuts().find((r) => r.descKey === 'shortcuts.liveMap');
  assert.ok(row);
  assert.deepEqual(row.chords, [['Ctrl', 'Shift', 'G']]);
  assert.match(read('src/renderer/modules/gitquick.js'), /!e\.shiftKey && \(e\.key === 'g'/);
});
