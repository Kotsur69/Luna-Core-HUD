// ============================================================================
// LunaCore - several live God Mode runs for the phone (MULTI_GODMODE_PLAN.md A5)
// ----------------------------------------------------------------------------
// godmodesnapshot.livesEntry / withLive / livesFrom, the snapshotputs `lives`
// overlay, the phone's model list (mobile/src/snapmodel.js, falling back to
// `live` for older PC builds), the live publisher reacting to the second
// run, and the toasts naming the repo (orchestraWiring.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { livesEntry, liveEntry, withLive, livesFrom, liveFrom, parseGodmodePeer, MAX_LIVES } = require('../src/godmodesnapshot');
const { createSnapshotPuts } = require('../src/snapshotputs');
const { createLivePublisher } = require('../src/godmodelivepub');
const { makeOrchestraDeps } = require('../src/orchestraWiring');

const NOW = Date.UTC(2026, 10, 3, 2);
const HOUR = 60 * 60 * 1000;

// Absolute paths in the shape of this PC; they must never reach the phone.
const REPO_A = path.join(os.homedir(), 'source', 'repos', 'Alpha');
const REPO_B = path.join(os.homedir(), 'source', 'repos', 'Beta');
const WT_B = path.join(os.homedir(), 'source', 'repos', '.luna-worktrees', 'Beta', 'b1');

const liveView = (id, repoPath, over = {}) => ({
  id,
  repoPath,
  roots: [],
  baseBranch: 'main',
  started: true,
  killed: false,
  settled: false,
  pausedUntil: null,
  runStartedAt: NOW - HOUR,
  options: {},
  packages: [{ id: 'a', title: 'A', state: 'launched', dependsOn: [], startedAt: NOW - 1000 }],
  ...over,
});

test('livesEntry: one entry per started run, nulls and unstarted runs skipped, paths scrubbed per run', () => {
  const beta = liveView('runb', REPO_B, {
    roots: [WT_B],
    packages: [{ id: 'b', title: 'B', state: 'stalled', error: 'verifyFailed', detail: `failed in ${WT_B}${path.sep}src${path.sep}x.js` }],
  });
  const lives = livesEntry([liveView('runa', REPO_A), null, liveView('runc', REPO_A, { started: false }), beta], { now: NOW });
  assert.deepEqual(lives.map((l) => [l.id, l.title]), [['runa', 'Alpha'], ['runb', 'Beta']]);
  assert.ok(!JSON.stringify(lives).includes(os.homedir()), 'no local path');
  assert.deepEqual(livesEntry(null), []);
  const many = Array.from({ length: MAX_LIVES + 3 }, (_, i) => liveView(`r${i}`, REPO_A));
  assert.equal(livesEntry(many, { now: NOW }).length, MAX_LIVES);
});

test('withLive carries lives (live = the first); a row parses back to both runs', () => {
  const lives = livesEntry([liveView('runa', REPO_A), liveView('runb', REPO_B)], { now: NOW });
  const snap = withLive(null, { live: lives[0], lives, tabs: [] }, { machine: 'PC1', now: NOW });
  assert.deepEqual(snap.lives.map((l) => l.id), ['runa', 'runb']);
  assert.equal(snap.live.id, 'runa');
  const peer = parseGodmodePeer({ machine: 'PC1', data: snap }, NOW);
  assert.deepEqual(peer.lives.map((l) => l.id), ['runa', 'runb']);
  assert.equal(liveFrom([{ machine: 'PC1', data: snap }], NOW).id, 'runa', 'an older phone build still reads live');
});

test('livesFrom: every PC\'s runs newest PC first; an older PC build counts with its one live', () => {
  const lives = livesEntry([liveView('runa', REPO_A), liveView('runb', REPO_B)], { now: NOW });
  const newPc = { machine: 'PC2', data: withLive(null, { live: lives[0], lives }, { machine: 'PC2', now: NOW - 1000 }) };
  const oldPc = { machine: 'PC1', data: { v: 1, at: NOW - 5000, machine: 'PC1', runs: [], tabs: [], live: liveEntry(liveView('old', REPO_A), { now: NOW }) } };
  const out = livesFrom([oldPc, newPc], NOW);
  assert.deepEqual(out.map((l) => [l.id, l.machine]), [['runa', 'PC2'], ['runb', 'PC2'], ['old', 'PC1']]);
  assert.equal(out[0].stale, false);
  assert.deepEqual(livesFrom('nope', NOW), []);
});

test('snapshotputs: godmode.live stores lives in the overlay; an older caller\'s live is the one run', async () => {
  const puts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lives-'));
  try {
    const sp = createSnapshotPuts({
      snapshots: () => ({ put: async (kind, data) => (puts.push([kind, data]), true) }),
      loggedIn: () => true,
      machine: 'PC1',
      readAll: async () => [],
      historyFile: () => path.join(dir, 'runs', 'godmode-snapshot.json'),
      now: () => NOW,
    });
    const lives = livesEntry([liveView('runa', REPO_A), liveView('runb', REPO_B)], { now: NOW });
    await sp.godmode.live({ live: lives[0], lives, tabs: [] });
    const last = () => puts.filter(([kind]) => kind === 'godmode').pop()[1];
    assert.deepEqual(last().lives.map((l) => l.id), ['runa', 'runb']);
    await sp.godmode.live({ live: lives[1], tabs: [] });
    assert.deepEqual(last().lives.map((l) => l.id), ['runb']);
    assert.equal(last().live.id, 'runb');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('phone model: godmodeLivesFrom lists both live runs, and falls back to live from an older PC', async () => {
  const model = await import('../mobile/src/snapmodel.js');
  const lives = livesEntry([liveView('runa', REPO_A), liveView('runb', REPO_B, { pausedUntil: NOW + HOUR })], { now: NOW });
  const row = { machine: 'PC1', data: withLive(null, { live: lives[0], lives }, { machine: 'PC1', now: NOW }) };
  const list = model.godmodeLivesFrom([row], NOW);
  assert.deepEqual(list.map((l) => [l.id, l.state]), [['runa', 'running'], ['runb', 'paused']]);
  const old = { machine: 'PC9', data: { v: 1, at: NOW, machine: 'PC9', runs: [], tabs: [], live: lives[0] } };
  assert.deepEqual(model.godmodeLivesFrom([old], NOW).map((l) => [l.id, l.machine]), [['runa', 'PC9']]);
});

test('live publisher: a state change in the second run goes out at once', () => {
  let section = null;
  const sent = [];
  const pub = createLivePublisher({
    build: () => section,
    publish: (s) => sent.push(s),
    now: () => NOW,
    setTimer: () => null,
    clearTimer: () => {},
  });
  const a = liveEntry(liveView('runa', REPO_A), { now: NOW });
  const b = liveEntry(liveView('runb', REPO_B), { now: NOW });
  section = { live: a, lives: [a, b], tabs: [] };
  pub.poke();
  assert.equal(sent.length, 1);
  const bPaused = liveEntry(liveView('runb', REPO_B, { pausedUntil: NOW + HOUR }), { now: NOW });
  section = { live: a, lives: [a, bPaused], tabs: [] };
  pub.poke();
  assert.equal(sent.length, 2, 'urgent despite the throttle window');
});

// ---- toasts name the repo ----------------------------------------------------

function wiringCtx(toasts, lives) {
  return {
    registry: () => ({ get: () => null, othersActive: () => false, repoBusy: () => false }),
    builder: { isBuilding: () => false, wrapPlanner: (fn) => fn, workerSettings: (b) => b, ownsMerge: () => false, onChange: () => {} },
    secretGate: { wrapSelfCheck: (fn) => fn, wrapPushBranch: (fn) => fn },
    overnight: { suspendAwake: () => {}, restoreAwake: () => {}, startRun: () => {} },
    sessions: new Map(),
    send: () => {},
    readUiPrefs: () => ({ notificationsEnabled: true }),
    readTodos: () => [],
    writeTodos: () => true,
    createSession: () => null,
    closeSession: () => {},
    usageResetAt: () => null,
    toolEnv: () => ({}),
    userDir: () => path.join(path.sep, 'cfg'),
    ensureUserDir: () => true,
    runsDir: () => path.join(path.sep, 'cfg', 'runs'),
    worktrees: {},
    putSnapshot: () => {},
    onReport: () => {},
    onLive: (view, projectId) => lives.push([view, projectId]),
    messageBox: () => null,
    toast: (title, body) => toasts.push([title, body]),
    projects: () => [{ id: 'alpha', label: 'Alpha project', path: REPO_A }],
    resolveStoredPath: (p) => p,
    flushTodos: () => {},
    usageLimits: () => [],
    accountFailover: () => false,
    freeProfileId: () => null,
    playCue: () => {},
    log: () => {},
    logError: () => {},
    store: { loadRun: () => null, saveRun: () => true },
  };
}

test('the morning toast and the power notices name the repo; onLive carries the project', () => {
  const toasts = [];
  const lives = [];
  const deps = makeOrchestraDeps('alpha', wiringCtx(toasts, lives));
  deps.notify({ pushed: 3, total: 4, failed: false });
  deps.notifyPower('sleepSoon');
  assert.equal(toasts[0][1], 'Alpha: 3/4 pushed');
  assert.match(toasts[1][1], /^Alpha: Usage limit - the PC sleeps/);
  deps.onLive({ id: 'p1' });
  assert.deepEqual(lives, [[{ id: 'p1' }, 'alpha']]);
  // A project that is not registered (any more) falls back to its id.
  const other = [];
  makeOrchestraDeps('ghost', wiringCtx(other, [])).notify({ pushed: 1, total: 1, failed: true });
  assert.equal(other[0][1], 'ghost: 1/1 pushed - integration needs you');
});
