// Attention inbox (src/inbox.js + src/inboxipc.js): which items show, the
// seen union across machines, and the IPC's validation.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { peersOf, collectRuns, seenUnion, buildInbox, findRun, WINDOW_MS } = require('../src/inbox');
const { registerInboxIpc } = require('../src/inboxipc');

const NOW = Date.UTC(2026, 9, 22, 12);
const HOUR = 60 * 60 * 1000;

const run = (id, finishedAt = NOW - HOUR, over = {}) => ({ id, finishedAt, repoName: 'repo', total: 1, pushed: 1, packages: [], ...over });
const snap = (machine, runs, seen) => ({ v: 1, at: NOW, machine, runs, ...(seen ? { seen } : {}) });
const row = (machine, runs, seen) => ({ machine, data: snap(machine, runs, seen) });

const inboxOf = ({ own = null, rows = [], checkin = null, goals = null, machine = 'PC1' } = {}) => {
  const peers = peersOf(own, rows, machine, NOW);
  return buildInbox({ runs: collectRuns(peers), seen: seenUnion(peers), checkin, goals, now: NOW });
};

test('runs from this PC and others show newest first, tagged with their machine', () => {
  const items = inboxOf({ own: snap('PC1', [run('aaa', NOW - 3 * HOUR)]), rows: [row('PC2', [run('bbb', NOW - HOUR, { needs: ['x', 'y'] })])] });
  assert.deepEqual(
    items.map((i) => [i.kind, i.id, i.machine, i.needs]),
    [['godmode', 'bbb', 'PC2', 2], ['godmode', 'aaa', 'PC1', 0]],
  );
  assert.deepEqual(Object.keys(items[0]).sort(), ['finishedAt', 'id', 'integrationState', 'kind', 'machine', 'needs', 'repoName']);
});

test('a run seen on ANY machine is gone everywhere', () => {
  const own = snap('PC1', [run('aaa'), run('bbb')]);
  const rows = [row('PC2', [run('ccc')], ['aaa']), row('PC3', [], ['ccc'])];
  assert.deepEqual(inboxOf({ own, rows }).map((i) => i.id), ['bbb']);
  const peers = peersOf(snap('PC1', [], ['bbb']), rows, 'PC1', NOW);
  assert.deepEqual([...seenUnion(peers)].sort(), ['aaa', 'bbb', 'ccc']);
});

test('only the last 7 days count, and a malformed run id is left out', () => {
  const own = snap('PC1', [run('old', NOW - WINDOW_MS - 1), run('edge', NOW - WINDOW_MS), run('Bad Id')]);
  assert.deepEqual(inboxOf({ own }).map((i) => i.id), ['edge']);
});

test('malformed rows and a broken own file are skipped, never thrown', () => {
  const rows = [null, { machine: 'x y', data: snap('x', [run('zzz')]) }, { machine: 'PC2', data: { v: 9 } }, row('PC3', [run('ok1')], 'notalist')];
  assert.deepEqual(inboxOf({ own: 'garbage', rows }).map((i) => i.id), ['ok1']);
  assert.deepEqual(inboxOf({ own: snap('PC1', [run('mine')]), machine: 'bad name' }), []);
});

test('the same run id on two machines shows once', () => {
  const items = inboxOf({ own: snap('PC1', [run('dup', NOW - 2 * HOUR)]), rows: [row('PC2', [run('dup', NOW - HOUR)])] });
  assert.deepEqual(items.map((i) => [i.id, i.machine]), [['dup', 'PC2']]);
});

test('check-in item only when today is neither answered nor skipped', () => {
  const kinds = (checkin) => inboxOf({ checkin }).map((i) => i.kind);
  assert.deepEqual(kinds({ today: '2026-10-22', entry: null }), ['checkin']);
  assert.deepEqual(kinds({ today: '2026-10-22', entry: { sleep: null, energy: null } }), [], 'skipped');
  assert.deepEqual(kinds({ today: '2026-10-22', entry: { sleep: 7, energy: 3 } }), []);
  assert.deepEqual(kinds(null), []);
});

test('goals item only when this week has no goals yet (a skip is [])', () => {
  const kinds = (goals) => inboxOf({ goals }).map((i) => i.kind);
  assert.deepEqual(kinds({ week: '2026-W43', goals: null }), ['goals']);
  assert.deepEqual(kinds({ week: '2026-W43', goals: [] }), []);
  assert.deepEqual(kinds({ week: '2026-W43', goals: [{ text: 'x' }] }), []);
});

test('an empty inbox is empty (the badge hides at 0)', () => {
  assert.deepEqual(inboxOf({ checkin: { today: 'd', entry: { sleep: 7, energy: 4 } }, goals: { week: 'w', goals: [] } }), []);
});

test('findRun matches machine and id', () => {
  const runs = collectRuns(peersOf(snap('PC1', [run('aaa')]), [row('PC2', [run('bbb')])], 'PC1', NOW));
  assert.equal(findRun(runs, 'PC2', 'bbb').id, 'bbb');
  assert.equal(findRun(runs, 'PC1', 'bbb'), null);
});

// --- IPC -----------------------------------------------------------------------

function ipc({ own = null, rows = [], listThrows = false } = {}) {
  const handlers = {};
  const marked = [];
  registerInboxIpc({
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn), on: () => {} },
    snapshots: () => ({ list: async () => (listThrows ? Promise.reject(new Error('offline')) : rows) }),
    godmode: { read: () => own, markSeen: async (id) => (marked.push(id), true) },
    machine: 'PC1',
    now: () => NOW,
    checkin: () => ({ today: '2026-10-22', entry: null }),
    goals: () => ({ week: '2026-W43', goals: [] }),
  });
  return { handlers, marked };
}

test('inbox:list answers plain items; a cloud failure still lists local ones', async () => {
  const { handlers } = ipc({ own: snap('PC1', [run('aaa')]), rows: [row('PC2', [run('bbb', NOW - 2 * HOUR)])] });
  const res = await handlers['inbox:list']();
  assert.deepEqual(res.items.map((i) => i.id || i.kind), ['aaa', 'bbb', 'checkin']);
  const offline = ipc({ own: snap('PC1', [run('aaa')]), listThrows: true });
  const silence = console.error;
  console.error = () => {};
  try {
    assert.deepEqual((await offline.handlers['inbox:list']()).items.map((i) => i.id || i.kind), ['aaa', 'checkin']);
  } finally {
    console.error = silence;
  }
});

test('inbox:run validates machine and id, returns the run and marks it seen', async () => {
  const { handlers, marked } = ipc({ rows: [row('PC2', [run('bbb', NOW - HOUR, { needs: ['n'], manual: ['env: KEY'] })])] });
  for (const bad of [null, {}, { machine: 'PC2' }, { machine: 'P C', id: 'bbb' }, { machine: 'PC2', id: '../x' }, { machine: 'PC2', id: 7 }]) {
    assert.deepEqual(await handlers['inbox:run'](null, bad), { ok: false, reason: 'bad-run' });
  }
  assert.deepEqual(await handlers['inbox:run'](null, { machine: 'PC2', id: 'nope' }), { ok: false, reason: 'not-found' });
  const res = await handlers['inbox:run'](null, { machine: 'PC2', id: 'bbb' });
  assert.equal(res.ok, true);
  assert.deepEqual([res.run.machine, res.run.needs, res.run.manual], ['PC2', ['n'], ['env: KEY']]);
  assert.deepEqual(marked, ['bbb']);
});

test('inbox:open-pr opens only a validated github.com link from the row', async () => {
  const handlers = {};
  const opened = [];
  const pkgs = [
    { id: 'a', title: 'A', state: 'pushed', prUrl: 'https://github.com/o/r/pull/1' },
    { id: 'b', title: 'B', state: 'pushed', prUrl: 'https://evil.example/x' },
  ];
  registerInboxIpc({
    ipcMain: { handle: () => {}, on: (ch, fn) => (handlers[ch] = fn) },
    snapshots: () => ({ list: async () => [row('PC2', [run('bbb', NOW - HOUR, { packages: pkgs })])] }),
    godmode: { read: () => null, markSeen: async () => true },
    machine: 'PC1',
    openExternal: async (url) => opened.push(url),
    now: () => NOW,
  });
  await handlers['inbox:open-pr'](null, { machine: 'PC2', id: 'bbb', pkg: 'a' });
  await handlers['inbox:open-pr'](null, { machine: 'PC2', id: 'bbb', pkg: 'b' });
  await handlers['inbox:open-pr'](null, { machine: 'PC2', id: 'bbb', url: 'https://github.com/x' });
  await handlers['inbox:open-pr'](null, null);
  assert.deepEqual(opened, ['https://github.com/o/r/pull/1']);
});
