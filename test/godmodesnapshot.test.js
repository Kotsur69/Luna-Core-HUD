// God Mode runs snapshot (src/godmodesnapshot.js): the run entry a PC builds
// at the end of a run, the capped history, and what a reader accepts.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEntry, addRun, parseGodmodePeer, runsFrom, prUrlOf } = require('../src/godmodesnapshot');

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;

const view = (over = {}) => ({
  id: 'abc123',
  repoPath: 'C:\\Users\\mati\\source\\repos\\Luna-Core-HUD',
  baseBranch: 'main',
  workerModel: 'opus',
  integrationMode: 'pr',
  integration: { state: 'done' },
  packages: [
    { id: 'a', title: 'Do A', state: 'pushed', branch: 'luna/a', headSha: 'abcdef0123', prUrl: 'https://github.com/o/r/pull/1', escalated: false, root: 'C:\\wt\\a' },
    { id: 'b', title: 'Do B', state: 'stalled', branch: 'luna/b', headSha: null, prUrl: null, error: 'verifyFailed', detail: '2 tests', escalated: true },
  ],
  ...over,
});

test('runEntry keeps the repo name only, packages and approval rules', () => {
  const run = runEntry(view(), { now: NOW, suggestions: [{ rule: 'Bash(npm test)', count: 2, ids: ['a'] }] });
  assert.deepEqual(run, {
    id: 'abc123',
    finishedAt: NOW,
    repoName: 'Luna-Core-HUD',
    baseBranch: 'main',
    workerModel: 'opus',
    integrationMode: 'pr',
    integrationState: 'done',
    pushed: 1,
    total: 2,
    packages: [
      { id: 'a', title: 'Do A', state: 'pushed', branch: 'luna/a', sha7: 'abcdef0', prUrl: 'https://github.com/o/r/pull/1', reason: '', escalated: false },
      { id: 'b', title: 'Do B', state: 'stalled', branch: 'luna/b', sha7: null, prUrl: null, reason: 'verifyFailed - 2 tests', escalated: true },
    ],
    approvalSuggestions: ['Bash(npm test)'],
    merged: 0,
    skipped: 0,
    blocked: 0,
    manualActions: 0,
    selfCheck: 'none',
  });
  assert.ok(!/Users|mati|wt/.test(JSON.stringify(run)));
  assert.equal(runEntry(null), null);
});

test('runEntry counts merged, skipped, blocked, manual actions and the self-check state', () => {
  const v = view({
    integrationMode: 'merge',
    integration: {
      state: 'done',
      skipped: [{ id: 'b', stage: 'conflict' }, { id: 'c', stage: 'depSkipped' }],
      manualActions: [{ kind: 'migration', what: 'x.sql' }, { kind: 'env', what: 'KEY' }, { kind: 'note', what: 'n' }],
      selfCheck: { tests: 'ok', syntax: 'failed', smoke: 'skipped', fixups: 1 },
    },
    packages: [
      { id: 'a', title: 'A', state: 'pushed', merged: true },
      { id: 'b', title: 'B', state: 'pushed', merged: false },
      { id: 'd', title: 'D', state: 'pending', blockedBy: 'x' },
      { id: 'e', title: 'E', state: 'pending', blockedBy: null },
    ],
  });
  const run = runEntry(v, { now: NOW });
  assert.deepEqual(
    [run.merged, run.skipped, run.blocked, run.manualActions, run.selfCheck],
    [1, 2, 1, 3, 'failed'],
  );
  const green = runEntry(view({ integration: { state: 'done', selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped' } } }), { now: NOW });
  assert.equal(green.selfCheck, 'ok');
});

test('a reader caps the new counts and still reads rows written before them', () => {
  const old = { id: 'old', finishedAt: NOW - HOUR, total: 2, pushed: 1, packages: [] };
  const hostile = { id: 'new', finishedAt: NOW, total: 2, packages: [], merged: 1e9, skipped: -3, blocked: 'x', manualActions: 1e9, selfCheck: '<b>' };
  const p = parseGodmodePeer({ machine: 'PC1', data: data([old, hostile]) }, NOW);
  const byId = Object.fromEntries(p.runs.map((r) => [r.id, r]));
  assert.deepEqual(
    [byId.old.merged, byId.old.skipped, byId.old.blocked, byId.old.manualActions, byId.old.selfCheck, byId.old.pushed],
    [0, 0, 0, 0, 'none', 1],
  );
  assert.equal(byId.new.merged, 2, 'merged never above total');
  assert.equal(byId.new.skipped, 0);
  assert.equal(byId.new.blocked, 0);
  assert.equal(byId.new.manualActions, 1000);
  assert.equal(byId.new.selfCheck, 'none');
});

test('addRun puts the newest first, replaces a rerun, keeps 10', () => {
  let snap = null;
  for (let i = 0; i < 12; i += 1) snap = addRun(snap, runEntry(view({ id: `r${i}` }), { now: NOW + i }), { machine: 'PC1', now: NOW + i });
  assert.equal(snap.runs.length, 10);
  assert.equal(snap.runs[0].id, 'r11');
  assert.equal(snap.machine, 'PC1');
  const again = addRun(snap, runEntry(view({ id: 'r5' }), { now: NOW + 20 }), { machine: 'PC1', now: NOW + 20 });
  assert.equal(again.runs[0].id, 'r5');
  assert.equal(again.runs.filter((r) => r.id === 'r5').length, 1);
});

test('prUrlOf keeps github.com https links only', () => {
  assert.equal(prUrlOf('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(prUrlOf('http://github.com/o/r/pull/1'), null);
  assert.equal(prUrlOf('https://github.com.evil.io/x'), null);
  assert.equal(prUrlOf('javascript:alert(1)'), null);
  assert.equal(prUrlOf('https://github.com/o/r/pull/1 "x"'), null);
});

const data = (runs, over = {}) => ({ v: 1, at: NOW, machine: 'PC1', runs, ...over });

test('parseGodmodePeer rejects bad rows and never throws', () => {
  assert.equal(parseGodmodePeer(null, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'x y', data: data([]) }, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'PC1', data: data([], { v: 2 }) }, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'PC1', data: { v: 1, at: NOW } }, NOW), null);
  const hostile = { machine: 'PC1', data: data([]) };
  Object.defineProperty(hostile.data, 'runs', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(parseGodmodePeer(hostile, NOW), null);
});

test('parseGodmodePeer strips control chars, caps lists, drops non-github PR links', () => {
  const pkgs = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, title: 't\u001b[31m', state: 'pushed', prUrl: 'https://evil.example/pr', sha7: 'ZZZ', reason: 'r'.repeat(999), extra: 'x' }));
  const runs = Array.from({ length: 15 }, (_, i) => ({
    id: `r${i}`,
    finishedAt: NOW - i * HOUR,
    repoName: 'C:\\x\u0000',
    total: 99,
    pushed: 500,
    packages: pkgs,
    approvalSuggestions: Array(40).fill('Bash(x)'),
  }));
  const p = parseGodmodePeer({ machine: 'PC1', data: data([...runs, { id: '', finishedAt: NOW }, { id: 'nofinish' }]) }, NOW);
  assert.equal(p.runs.length, 10);
  const r = p.runs[0];
  assert.equal(r.packages.length, 50);
  assert.equal(r.approvalSuggestions.length, 20);
  assert.equal(r.pushed, 99, 'pushed never above total');
  assert.equal(r.repoName, 'C:\\x');
  const pkg = r.packages[0];
  assert.deepEqual(Object.keys(pkg).sort(), ['branch', 'escalated', 'id', 'prUrl', 'reason', 'sha7', 'state', 'title']);
  assert.equal(pkg.title, 't [31m');
  assert.equal(pkg.prUrl, null);
  assert.equal(pkg.sha7, null);
  assert.equal(pkg.reason.length, 300);
});

test('runsFrom merges machines newest first and tags each run', () => {
  const rows = [
    { machine: 'PC1', data: data([{ id: 'a', finishedAt: NOW - 2 * HOUR, packages: [] }]) },
    { machine: 'PC2', data: data([{ id: 'b', finishedAt: NOW - HOUR, packages: [] }]) },
    { machine: 'PC3', data: { v: 9 } },
  ];
  const out = runsFrom(rows, NOW);
  assert.deepEqual(out.map((r) => [r.id, r.machine]), [['b', 'PC2'], ['a', 'PC1']]);
});

// ---------------------------------------------------------------------------
// Live run section + tab lights, and the throttled publisher.
// ---------------------------------------------------------------------------

const { liveEntry, tabsEntry, withLive, liveFrom, tabsFrom, liveCounts, scrubPaths, LIVE_STALE_MS } = require('../src/godmodesnapshot');
const { createLivePublisher, MIN_MS, HEARTBEAT_MS } = require('../src/godmodelivepub');

const REPO = 'C:\\Users\\mati\\source\\repos\\Luna-Core-HUD';
const WT = 'C:\\Users\\mati\\source\\repos\\.luna-worktrees\\Luna-Core-HUD\\b-x1';

const liveView = (over = {}) => ({
  id: 'run1',
  repoPath: REPO,
  roots: [WT],
  baseBranch: 'main',
  started: true,
  killed: false,
  settled: false,
  pausedUntil: null,
  runStartedAt: NOW - HOUR,
  options: { sleepOnLimit: true, shutdownWhenDone: false, unattendedApprovalMin: 5 },
  packages: [
    { id: 'a', title: 'Do A', state: 'pushed', dependsOn: [], headSha: 'ABCDEF0123', prUrl: 'https://github.com/o/r/pull/1', todos: ['todo A'], startedAt: NOW - HOUR, sessionId: 's1', root: WT },
    { id: 'b', title: 'Do B', state: 'launched', dependsOn: ['a'], headSha: null, prUrl: 'https://evil.example/pr', startedAt: NOW - 10 * 60000, pausedMs: 60000, sessionId: 's2' },
    { id: 'c', title: 'Do C', state: 'stalled', dependsOn: ['a'], error: 'verifyFailed', detail: `test failed in ${WT}\\src\\x.js and C:\\Users\\mati\\secret\\y.js`, sessionId: 's3' },
    { id: 'd', title: 'Do D', state: 'pending', dependsOn: ['b', 'c'] },
    { id: 'e', title: 'Do E', state: 'finishing', startedAt: NOW - 1000, sessionId: 's5' },
    { id: 'f', title: 'Do F', state: 'stalled', error: 'needsApproval', detail: 'Bash(rm /home/mati/x/y.txt)', sessionId: 's6' },
  ],
  ...over,
});

const tabStates = { s1: 'idle', s2: 'approval', s5: 'working' };
const tabState = (id) => tabStates[id] || null;

test('liveEntry maps package states, keeps github PR links only and no local paths', () => {
  const live = liveEntry(liveView(), { now: NOW, tabState });
  assert.equal(live.title, 'Luna-Core-HUD');
  assert.equal(live.state, 'running');
  assert.equal(live.startedAt, NOW - HOUR);
  assert.deepEqual(live.options, { sleepOnLimit: true, shutdownWhenDone: false });
  const byId = Object.fromEntries(live.packages.map((p) => [p.id, p]));
  assert.deepEqual(
    live.packages.map((p) => [p.id, p.state]),
    [['a', 'pushed'], ['b', 'approval'], ['c', 'failed'], ['d', 'queued'], ['e', 'verifying'], ['f', 'approval']],
  );
  assert.equal(byId.a.sha7, 'abcdef0');
  assert.equal(byId.a.prUrl, 'https://github.com/o/r/pull/1');
  assert.deepEqual(byId.a.todos, ['todo A']);
  assert.equal(byId.b.prUrl, null);
  assert.equal(byId.b.elapsedMs, 9 * 60000, 'pause time does not count');
  assert.equal(byId.a.elapsedMs, null, 'only running packages tick');
  assert.deepEqual(byId.d.dependsOn, ['b', 'c']);
  assert.equal(byId.c.error, 'verifyFailed');
  assert.equal(byId.c.detail, 'test failed in src\\x.js and y.js');
  assert.equal(byId.f.detail, 'Bash(rm y.txt)');
  assert.ok(!/Users|mati|worktrees|C:/.test(JSON.stringify(live)), JSON.stringify(live));
});

test('liveEntry run state: paused with its time, settled, killed; nothing before start', () => {
  const until = NOW + HOUR;
  const paused = liveEntry(liveView({ pausedUntil: until }), { now: NOW });
  assert.deepEqual([paused.state, paused.pausedUntil], ['paused', until]);
  assert.equal(liveEntry(liveView({ settled: true }), { now: NOW }).state, 'settled');
  assert.equal(liveEntry(liveView({ killed: true, settled: true }), { now: NOW }).state, 'killed');
  assert.equal(liveEntry(liveView({ started: false }), { now: NOW }), null);
  assert.equal(liveEntry(null, { now: NOW }), null);
  assert.deepEqual(liveCounts(liveEntry(liveView(), { now: NOW, tabState })), { pushed: 1, working: 1, waiting: 2, pending: 1, failed: 1 });
});

test('tabsEntry keeps folder / profile names and the light only', () => {
  const tabs = tabsEntry([
    { folder: 'Luna-Core-HUD', profileLabel: 'Claude', cwd: REPO, status: { state: 'approval', since: 1 } },
    { folder: 'C:\\Users\\mati\\proj', profileLabel: 'Codex', status: null },
    { folder: '', profileLabel: '' },
    null,
  ]);
  assert.deepEqual(tabs, [
    { folder: 'Luna-Core-HUD', profile: 'Claude', state: 'approval' },
    { folder: 'proj', profile: 'Codex', state: 'idle' },
  ]);
});

test('scrubPaths cuts repo roots on either separator and other absolute paths', () => {
  assert.equal(scrubPaths('see C:/Users/mati/source/repos/Luna-Core-HUD/src/a.js', [REPO]), 'see src/a.js');
  assert.equal(scrubPaths('in /Users/mati/code/b.ts line 3'), 'in b.ts line 3');
  assert.equal(scrubPaths('\\\\server\\share\\c.txt'), 'c.txt');
  assert.equal(scrubPaths(42), '');
});

const liveRow = (live, over = {}) => ({ machine: 'PC1', data: { v: 1, at: NOW, machine: 'PC1', runs: [], live, tabs: [], ...over } });

test('a reader caps the live section, re-checks PR links, scrubs paths and drops bad states', () => {
  const pkgs = Array.from({ length: 80 }, (_, i) => ({
    id: `p${i}`,
    title: 'x'.repeat(999),
    state: i === 0 ? 'hacked' : 'pushed',
    sha7: 'abcdef0',
    prUrl: i === 1 ? 'https://github.com/o/r/pull/2' : 'javascript:alert(1)',
    detail: 'C:\\Users\\mati\\a\\b.js broke',
    dependsOn: Array(50).fill('a'),
    todos: Array(50).fill('t'),
    elapsedMs: 1e15,
    output: 'terminal text',
  }));
  const raw = { id: 'r', title: 't', startedAt: NOW + HOUR, state: 'running', pausedUntil: NOW, options: { sleepOnLimit: 'yes' }, packages: pkgs };
  const live = liveFrom([liveRow(raw)], NOW);
  assert.equal(live.packages.length, 50);
  assert.equal(live.startedAt, NOW, 'a future start is clamped');
  assert.equal(live.pausedUntil, null, 'only a paused run has a pause time');
  assert.equal(live.options.sleepOnLimit, false);
  const [p0, p1] = live.packages;
  assert.equal(p0.state, 'queued');
  assert.equal(p0.sha7, null, 'a sha only on a pushed package');
  assert.equal(p0.prUrl, null);
  assert.equal(p1.prUrl, 'https://github.com/o/r/pull/2');
  assert.equal(p1.title.length, 200);
  assert.equal(p1.dependsOn.length, 20);
  assert.equal(p1.todos.length, 10);
  assert.equal(p1.detail, 'b.js broke');
  assert.equal(p1.elapsedMs, 7 * 24 * HOUR);
  assert.ok(!('output' in p1));
  assert.equal(liveFrom([liveRow({ ...raw, state: 'weird' })], NOW), null);
  assert.equal(liveFrom([liveRow(undefined)], NOW), null, 'a row from before live reads as no live run');
});

test('liveFrom picks the newest PC and flags a stale snapshot; tabsFrom caps tabs', () => {
  const raw = (id) => ({ id, title: id, startedAt: NOW - HOUR, state: 'running', packages: [] });
  const rows = [liveRow(raw('old'), { at: NOW - LIVE_STALE_MS - 1000 }), { machine: 'PC2', data: { v: 1, at: NOW - 5000, runs: [], live: raw('new') } }];
  const live = liveFrom(rows, NOW);
  assert.deepEqual([live.id, live.machine, live.stale], ['new', 'PC2', false]);
  assert.equal(liveFrom([rows[0]], NOW).stale, true);
  const tabs = Array.from({ length: 40 }, (_, i) => ({ folder: `f${i}`, profile: 'p', state: i ? 'working' : 'evil' }));
  const out = tabsFrom([liveRow(null, { tabs })], NOW);
  assert.equal(out[0].tabs.length, 30);
  assert.equal(out[0].tabs[0].state, 'idle');
});

test('withLive lays the live section over the run history', () => {
  const hist = addRun(null, runEntry(view(), { now: NOW }), { machine: 'PC1', now: NOW });
  const live = liveEntry(liveView(), { now: NOW });
  const snap = withLive(hist, { live, tabs: [{ folder: 'f', profile: 'p', state: 'done' }] }, { machine: 'PC1', now: NOW + 1 });
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.at, NOW + 1);
  assert.equal(snap.live.id, 'run1');
  assert.equal(snap.tabs.length, 1);
  assert.ok(!('live' in withLive(hist, { live: null }, { machine: 'PC1', now: NOW })));
  assert.ok(parseGodmodePeer({ machine: 'PC1', data: snap }, NOW + 1).live);
});

/** Fake clock + timers for the publisher. */
function fakeTimers() {
  let t = NOW;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: t + ms });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function publisherHarness() {
  const clock = fakeTimers();
  const sent = [];
  let section = { live: liveEntry(liveView(), { now: NOW }), tabs: [] };
  const pub = createLivePublisher({ build: () => section, publish: (s) => sent.push(s), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
  const set = (fn) => {
    section = fn(section);
  };
  const withPkg = (s, id, patch) => ({ ...s, live: { ...s.live, packages: s.live.packages.map((p) => (p.id === id ? { ...p, ...patch } : p)) } });
  return { clock, sent, pub, set, withPkg };
}

test('publisher: first poke and every package state change go out at once', () => {
  const { sent, pub, set, withPkg } = publisherHarness();
  pub.poke();
  assert.equal(sent.length, 1);
  set((s) => withPkg(s, 'd', { state: 'working' }));
  pub.poke();
  assert.equal(sent.length, 2, 'state change is not throttled');
  set((s) => ({ ...s, live: { ...s.live, state: 'paused', pausedUntil: NOW + HOUR } }));
  pub.poke();
  assert.equal(sent.length, 3, 'pause is not throttled');
});

test('publisher: other changes are throttled to one per 15 s, unchanged content is skipped', () => {
  const { clock, sent, pub, set, withPkg } = publisherHarness();
  pub.poke();
  set((s) => ({ ...s, tabs: [{ folder: 'f', profile: 'p', state: 'working' }] }));
  pub.poke();
  set((s) => ({ ...s, tabs: [{ folder: 'f', profile: 'p', state: 'idle' }] }));
  pub.poke();
  assert.equal(sent.length, 1);
  clock.advance(MIN_MS - 1);
  assert.equal(sent.length, 1);
  clock.advance(1);
  assert.equal(sent.length, 2, 'the trailing change goes out when the window opens');
  assert.equal(sent[1].tabs[0].state, 'idle');
  // Only the clock moved: no put until the heartbeat.
  set((s) => withPkg(s, 'b', { elapsedMs: 123456 }));
  clock.advance(MIN_MS * 2);
  pub.poke();
  assert.equal(sent.length, 2);
  clock.advance(HEARTBEAT_MS);
  assert.equal(sent.length, 3, 'a running run sends a heartbeat for the stale badge');
});

test('publisher: a settled run sends once and stops its heartbeat', () => {
  const { clock, sent, pub, set } = publisherHarness();
  pub.poke();
  set((s) => ({ ...s, live: { ...s.live, state: 'settled' } }));
  pub.poke();
  assert.equal(sent.length, 2);
  assert.equal(clock.pending(), 0);
  clock.advance(HEARTBEAT_MS * 5);
  assert.equal(sent.length, 2);
});

test('publisher: a failing build or publish only logs', () => {
  const logs = [];
  const broken = createLivePublisher({
    build: () => {
      throw new Error('boom');
    },
    publish: () => {},
    log: (m) => logs.push(m),
  });
  assert.doesNotThrow(() => broken.poke());
  const failing = createLivePublisher({
    build: () => ({ live: null, tabs: [] }),
    publish: () => {
      throw new Error('net');
    },
    log: (m) => logs.push(m),
  });
  assert.doesNotThrow(() => failing.poke());
  assert.equal(logs.length, 2);
});
