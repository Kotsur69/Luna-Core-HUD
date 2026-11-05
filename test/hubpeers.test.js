// ============================================================================
// LunaCore - notification hub across PCs (docs/NOTIFICATION_HUB_PLAN.md N4)
// ----------------------------------------------------------------------------
// - godmodesnapshot v2: a run carries needsYou / manualActionLines, capped,
//   paths scrubbed, control characters out; v1 rows still parse;
// - hubpeers: other PCs' rows become items with `machine`, re-cleaned, no
//   action; every run shows (needs with lines, info without); 14 / 30 days;
// - hubdone: the v1 file migrates, marks become `hub:done:<id>` config units,
//   a peer's mark merges in, old marks are pruned and refused;
// - the launch auto-open rule.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const snap = require('../src/godmodesnapshot.js');
const { collectPeers, createHubPeers, STALE_MS, DROP_MS } = require('../src/hubpeers.js');
const { collectGodmode } = require('../src/hubcollect.js');
const hubdone = require('../src/hubdone.js');
const { createHub, mergeItems } = require('../src/hub.js');
const { createConfigSync } = require('../src/configsync.js');

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hubpeers-'));

const REPORT = [
  '# God Mode run p1abc',
  '',
  '- Repo: `C:\\Users\\mati\\source\\repos\\demo`',
  '- Result: 1 of 2 packages pushed',
  '',
  '## Needs you',
  '',
  '- check C:\\Users\\mati\\source\\repos\\demo\\src\\x.js by hand',
  '- 2 manual actions to apply live - see Manual actions.',
  '    self-check tail line',
  '',
  '## Manual actions',
  '',
  '### Migrations',
  '',
  '- `supabase/migrations/001.sql` (from abc1234)',
  '- restart the host\u202e evil',
  '',
].join('\n');

const view = () => ({
  id: 'p1abc',
  repoPath: 'C:\\Users\\mati\\source\\repos\\demo',
  baseBranch: 'main',
  integration: { state: 'done', manualActions: [{ kind: 'migration', what: 'x' }, { kind: 'note', what: 'y' }] },
  packages: [{ id: 'a', title: 'A', state: 'pushed', merged: true }, { id: 'b', title: 'B', state: 'stalled' }],
});

const row = (machine, runs, v = 2, over = {}) => ({ machine, data: { v, at: NOW - 1000, machine, runs, ...over } });

// --- godmodesnapshot v2 -----------------------------------------------------

test('runEntry v2 carries scrubbed needsYou / manualActionLines', () => {
  const run = snap.runEntry(view(), { now: NOW, report: REPORT });
  assert.deepEqual(run.needsYou, ['check src\\x.js by hand']);
  assert.deepEqual(run.manualActionLines, ['supabase/migrations/001.sql (from abc1234)', 'restart the host evil']);
  assert.ok(!/Users|mati/.test(JSON.stringify(run)), 'no local path travels');
  const next = snap.addRun(null, run, { machine: 'PC1', now: NOW });
  assert.equal(next.v, 2);
});

test('v2 lines are capped at 10 x 200, deduped and stripped of control characters', () => {
  const long = Array.from({ length: 30 }, (_, i) => `- line ${i} ${'x'.repeat(400)}`);
  const report = ['## Needs you', '', ...long, '- dup', '- dup', ''].join('\n');
  const { needsYou } = snap.reportLines(report);
  assert.equal(needsYou.length, snap.HUB_MAX_LINES);
  assert.ok(needsYou.every((l) => l.length <= snap.HUB_MAX_LINE));
  const hostile = snap.parseGodmodePeer(row('PC2', [{
    id: 'r1', finishedAt: NOW, total: 1, packages: [],
    needsYou: [...Array(20).fill('same'), 'a\u0000b', `see /home/mati/x/y.txt ${'z'.repeat(500)}`, 42],
    manualActionLines: 'not a list',
  }]), NOW);
  const r = hostile.runs[0];
  assert.deepEqual(r.needsYou.slice(0, 2), ['same', 'a b']);
  assert.ok(r.needsYou.length <= snap.HUB_MAX_LINES);
  assert.ok(r.needsYou.every((l) => !/home|mati/.test(l) && l.length <= snap.HUB_MAX_LINE));
  assert.deepEqual(r.manualActionLines, []);
  assert.equal(snap.hubLine(snap.hubLine('C:\\a\\b c')), snap.hubLine('C:\\a\\b c'), 'idempotent');
});

test('v1 rows still parse, without hub lines (counts only)', () => {
  const p = snap.parseGodmodePeer(row('PC2', [{ id: 'r1', finishedAt: NOW, total: 2, pushed: 1, manualActions: 3, needs: ['x'], packages: [] }], 1), NOW);
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].manualActions, 3);
  assert.ok(!('needsYou' in p.runs[0]));
  // This PC's own v1 history is built on, and its old runs stay counts-only.
  const next = snap.addRun(row('PC1', [{ id: 'old', finishedAt: NOW - 5, total: 1, packages: [] }], 1).data, snap.runEntry(view(), { now: NOW, report: REPORT }), { machine: 'PC1', now: NOW });
  assert.deepEqual(next.runs.map((r) => r.id), ['p1abc', 'old']);
  assert.ok(!('needsYou' in next.runs[1]));
});

// --- hubpeers ---------------------------------------------------------------

test('peers: a v2 run with lines gives needs items from <machine>, without actions', () => {
  const run = snap.runEntry(view(), { now: NOW - DAY, report: REPORT });
  const items = collectPeers({ rows: [row('KT-PC', [run])], now: NOW });
  const needs = items.filter((i) => i.kind === 'needs');
  assert.equal(needs.length, 3);
  assert.ok(items.every((i) => i.machine === 'KT-PC' && !i.primary));
  assert.equal(items.find((i) => i.id === 'godmode:p1abc').kind, 'info');
  // The same ids as the PC that ran it (so a synced done mark clears both).
  const local = collectGodmode({ runs: [{ id: 'p1abc', mtime: NOW - DAY, text: REPORT }], now: NOW });
  assert.deepEqual(needs.map((i) => i.id).sort(), local.filter((i) => i.kind === 'needs').map((i) => i.id).sort());
});

test('peers: every run shows; clean = info, v1 = counts, stale = info, too old = gone', () => {
  const clean = { id: 'rclean', finishedAt: NOW - DAY, total: 2, merged: 2, packages: [], needsYou: [], manualActionLines: [] };
  const v1 = { id: 'rv1', finishedAt: NOW - DAY, total: 2, pushed: 1, manualActions: 2, packages: [] };
  const stale = { id: 'rstale', finishedAt: NOW - STALE_MS - DAY, total: 1, packages: [], needsYou: ['old thing'], manualActionLines: [] };
  const gone = { id: 'rgone', finishedAt: NOW - DROP_MS - DAY, total: 1, packages: [], needsYou: ['ancient'], manualActionLines: [] };
  const items = collectPeers({ rows: [row('PC2', [clean, stale, gone]), row('PC3', [v1], 1)], now: NOW });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['godmode:rclean'].kind, 'info');
  assert.equal(byId['godmode:rclean'].vars.result, '2 of 2 merged');
  assert.equal(byId['godmode:rv1'].kind, 'needs');
  assert.equal(byId['godmode:rv1'].detailKey, 'hub.item.gmPeerCounts');
  assert.match(byId['godmode:rv1'].detail, /details in your email/);
  assert.ok(items.filter((i) => i.id.startsWith('godmode:rstale')).every((i) => i.kind === 'info'));
  assert.ok(!items.some((i) => i.id.startsWith('godmode:rgone')));
});

test('peers: hostile rows are re-cleaned or dropped, never throw', () => {
  const evil = [
    null, 42, { machine: '../x', data: {} }, row('PC2', 'nope'),
    row('PC2', [{ id: 'BAD ID', finishedAt: NOW, packages: [] }, { id: 'r1', finishedAt: NOW, repoName: 'x\u0000y', total: 1, packages: [], needsYou: ['C:\\Users\\mati\\a.txt', '\u202eflip'], manualActionLines: [] }]),
  ];
  const items = collectPeers({ rows: evil, now: NOW });
  assert.ok(items.length > 0);
  assert.ok(!items.some((i) => i.id.includes('BAD')));
  const merged = mergeItems([items], { now: NOW }).items;
  // eslint-disable-next-line no-control-regex
  for (const i of merged) assert.ok(!/Users|mati|[\u0000-\u001f\u202e]/.test(`${i.title} ${i.detail || ''}`));
  assert.deepEqual(collectPeers({ rows: 'x', now: NOW }), []);
  assert.deepEqual(collectPeers(null), []);
});

test('createHubPeers: background fetch, onChange once per change, cloud off or failing is empty', async () => {
  let clock = NOW;
  let rows = [row('PC2', [])];
  let calls = 0;
  let changes = 0;
  const peers = createHubPeers({
    snapshots: () => ({ list: async (kind) => { calls += 1; assert.equal(kind, 'godmode'); return rows; } }),
    now: () => clock,
    onChange: () => { changes += 1; },
  });
  assert.deepEqual(peers.rows(), [], 'never waits');
  await peers.refresh();
  assert.equal(peers.rows().length, 1);
  assert.equal(changes, 1);
  assert.equal(calls, 1, 'no second fetch inside the window');
  clock += 61_000;
  await peers.refresh();
  assert.equal(changes, 1, 'same rows, no change');
  rows = [];
  clock += 61_000;
  await peers.refresh();
  assert.equal(changes, 2);
  const off = createHubPeers({ snapshots: () => null });
  assert.equal(await off.refresh(), false);
  const broken = createHubPeers({ snapshots: () => ({ list: async () => { throw new Error('offline'); } }) });
  assert.equal(await broken.refresh(), false);
  assert.deepEqual(broken.rows(), []);
});

// --- hubdone ----------------------------------------------------------------

test('done store: the N1 v1 file migrates to v2 and keeps its marks', () => {
  const file = path.join(tmpDir(), 'hub-done.local.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, done: { 'life:a': NOW - 1000, 'Bad id': NOW } }));
  const store = hubdone.createDoneStore({ file: () => file, now: () => NOW });
  assert.deepEqual([...store.load().keys()], ['life:a']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2, done: { 'life:a': NOW - 1000 } });
});

test('done sync: marks merge across PCs as config units; old ones are pruned and refused', () => {
  const dir = tmpDir();
  let clock = NOW;
  const pcs = {};
  const peersOf = (name) => Object.entries(pcs).filter(([n, pc]) => n !== name && pc.published()).map(([, pc]) => pc.published());
  const mk = (name) => {
    const store = hubdone.createDoneStore({ file: () => path.join(dir, `${name}-done.local.json`), now: () => clock });
    let published = null;
    const sync = createConfigSync({
      providers: [hubdone.createHubDoneProvider(store, { now: () => clock })],
      metaFile: path.join(dir, `${name}-meta.local.json`),
      now: () => clock,
      extraPeers: () => peersOf(name),
      onPublish: (doc) => { published = doc; },
    });
    return { store, sync, published: () => published };
  };
  pcs.a = mk('a');
  pcs.b = mk('b');
  pcs.a.store.mark('godmode:p1abc:needs:0123456789');
  pcs.a.sync.syncOnce();
  assert.deepEqual(pcs.a.published().units.map((u) => [u.k, u.v]), [['hub:done:godmode:p1abc:needs:0123456789', { at: NOW }]]);
  clock += 1000;
  pcs.b.store.mark('life:checkin:2026-11-02');
  assert.deepEqual(pcs.b.sync.syncOnce(), ['hubdone']);
  assert.ok(pcs.b.store.load().has('godmode:p1abc:needs:0123456789'), "A's mark reached B");
  clock += 1000;
  pcs.a.sync.syncOnce();
  assert.deepEqual([...pcs.a.store.load().keys()].sort(), ['godmode:p1abc:needs:0123456789', 'life:checkin:2026-11-02']);
  // 31 days on: pruned locally, and a stale peer value is refused.
  clock = NOW + hubdone.DONE_KEEP_MS + 5000;
  assert.equal(hubdone.validMark('hub:done:life:x', { at: NOW }, clock), null);
  pcs.a.sync.syncOnce();
  assert.equal(pcs.a.store.load().size, 0);
  assert.equal(pcs.a.published().units.length, 0);
});

test('validMark refuses foreign keys, bad ids and odd values', () => {
  const bad = [['hub:done:Bad', { at: NOW }], ['host:default', { at: NOW }], ['hub:done:a:b', { at: 'x' }], ['hub:done:a:b', null], ['hub:done:a:b', { at: NOW + 5 * DAY }]];
  for (const [k, v] of bad) assert.equal(hubdone.validMark(k, v, NOW), null, `${k} ${JSON.stringify(v)}`);
  assert.deepEqual(hubdone.validMark('hub:done:a:b', { at: NOW, extra: '<x>' }, NOW), { at: NOW });
});

// --- seen + auto-open -------------------------------------------------------

test('hub view: unseen counts needs not shown yet; markSeen clears it', () => {
  const seenStore = hubdone.createSeenStore({ file: () => null, now: () => NOW });
  const collect = () => [{ id: 'life:a', kind: 'needs', source: 'life', title: 'A', at: NOW }, { id: 'life:b', kind: 'info', source: 'life', title: 'B', at: NOW }];
  const h = createHub({ sources: { s: { collect, read: () => ({}) } }, doneStore: hubdone.createDoneStore({ file: () => null, now: () => NOW }), seenStore, now: () => NOW });
  assert.equal(h.refresh(true).unseen, 1);
  assert.deepEqual(h.markSeen(), { ok: true, unseen: 0 });
  assert.equal(h.list().needs, 1, 'seen is not done');
});

test('auto-open rule: only when needed by default, always / never, once, launch window only', async () => {
  const { shouldAutoOpen, normalizeAutoOpen, AUTO_OPEN_WINDOW_MS } = await import('../src/renderer/modules/hubrules.js');
  assert.equal(shouldAutoOpen({ unseen: 2 }), true);
  assert.equal(shouldAutoOpen({ unseen: 0 }), false);
  assert.equal(shouldAutoOpen({ mode: 'needed', unseen: 1, opened: true }), false, 'once');
  assert.equal(shouldAutoOpen({ mode: 'always', unseen: 0 }), true);
  assert.equal(shouldAutoOpen({ mode: 'never', unseen: 5 }), false);
  assert.equal(shouldAutoOpen({ unseen: 1, sinceLaunchMs: AUTO_OPEN_WINDOW_MS + 1 }), false);
  assert.equal(shouldAutoOpen({ mode: 'bogus', unseen: 1 }), true, 'unknown mode = default');
  assert.equal(normalizeAutoOpen('never'), 'never');
  assert.equal(normalizeAutoOpen(undefined), 'needed');
});

// --- security review regressions ---------------------------------------------

test('a remote copy never replaces this PC\'s own item with the same id', () => {
  const local = { id: 'godmode:p1abc', kind: 'info', source: 'godmode', title: 'local', at: NOW - DAY, primary: { action: 'openReport', arg: 'p1abc' } };
  const remote = { id: 'godmode:p1abc', kind: 'needs', source: 'godmode', title: 'spoof', at: NOW, machine: 'EVIL' };
  for (const lists of [[[local], [remote]], [[remote], [local]]]) {
    const [only] = mergeItems(lists, { now: NOW }).items;
    assert.equal(only.title, 'local');
    assert.equal(only.primary.action, 'openReport');
  }
});

test('a peer run dated in the future is left out', () => {
  const future = { id: 'rfut', finishedAt: NOW + DAY, total: 1, packages: [], needsYou: ['pinned forever'], manualActionLines: [] };
  const ok = { id: 'rok', finishedAt: NOW - 1000, total: 1, packages: [], needsYou: [], manualActionLines: [] };
  const ids = collectPeers({ rows: [row('PC2', [future, ok])], now: NOW }).map((i) => i.id);
  assert.deepEqual(ids, ['godmode:rok']);
});

test('future-dated synced marks are clamped and cannot evict this PC\'s marks', () => {
  const file = path.join(tmpDir(), 'hub-done.local.json');
  const store = hubdone.createDoneStore({ file: () => file, now: () => NOW });
  store.mark('life:mine');
  const flood = Array.from({ length: 600 }, (_, i) => [`life:f${i}`, NOW + 20 * 60 * 60 * 1000]);
  store.replace([['life:mine', NOW], ...flood]);
  const marks = store.load();
  assert.ok(marks.has('life:mine'), 'kept first');
  assert.equal(marks.size, 500);
  assert.ok([...marks.values()].every((at) => at <= NOW), 'clamped to now');
  assert.deepEqual(hubdone.validMark('hub:done:a:b', { at: NOW + 1000 }, NOW), { at: NOW });
});

test('format and invisible characters are stripped from hub lines and titles', () => {
  const nasty = `a\u00adb\u2060c\u061cd\u{E0041}e\u0085f`;
  assert.equal(snap.hubLine(nasty), 'a b c d e f');
  const [item] = mergeItems([[{ id: 'life:x', kind: 'info', source: 'life', title: nasty, at: NOW }]], { now: NOW }).items;
  assert.equal(item.title, 'a b c d e f');
});
