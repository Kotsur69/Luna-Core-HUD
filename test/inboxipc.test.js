// God Mode run summary IPC (src/inboxipc.js): the run lookup across this PC
// and the other PCs' rows, and the handlers' validation. N8 folded the old
// attention inbox list into the notification hub; inbox:run and
// inbox:open-pr stay (the hub's openRunSummary action uses them).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerInboxIpc, peersOf, collectRuns, findRun } = require('../src/inboxipc');

const NOW = Date.UTC(2026, 9, 22, 12);
const HOUR = 60 * 60 * 1000;

const run = (id, finishedAt = NOW - HOUR, over = {}) => ({ id, finishedAt, repoName: 'repo', total: 1, pushed: 1, packages: [], ...over });
const snap = (machine, runs, seen) => ({ v: 1, at: NOW, machine, runs, ...(seen ? { seen } : {}) });
const row = (machine, runs, seen) => ({ machine, data: snap(machine, runs, seen) });

test('runs from this PC and others, newest first, tagged with their machine', () => {
  const runs = collectRuns(peersOf(snap('PC1', [run('aaa', NOW - 3 * HOUR)]), [row('PC2', [run('bbb', NOW - HOUR)])], 'PC1', NOW));
  assert.deepEqual(runs.map((r) => [r.id, r.machine]), [['bbb', 'PC2'], ['aaa', 'PC1']]);
});

test('malformed rows and a broken own file are skipped, never thrown', () => {
  const rows = [null, { machine: 'x y', data: snap('x', [run('zzz')]) }, { machine: 'PC2', data: { v: 9 } }, row('PC3', [run('ok1')])];
  assert.deepEqual(collectRuns(peersOf('garbage', rows, 'PC1', NOW)).map((r) => r.id), ['ok1']);
  assert.deepEqual(collectRuns(peersOf(snap('PC1', [run('mine')]), [], 'bad name', NOW)), []);
});

test('findRun matches machine and id (the same id on two PCs stays apart)', () => {
  const runs = collectRuns(peersOf(snap('PC1', [run('aaa'), run('dup', NOW - 2 * HOUR)]), [row('PC2', [run('bbb'), run('dup')])], 'PC1', NOW));
  assert.equal(findRun(runs, 'PC2', 'bbb').id, 'bbb');
  assert.equal(findRun(runs, 'PC1', 'bbb'), null);
  assert.equal(findRun(runs, 'PC1', 'dup').machine, 'PC1');
  assert.equal(findRun(runs, 'PC2', 'dup').machine, 'PC2');
});

test('the old inbox list is gone: no inbox:list handler', () => {
  const handlers = {};
  registerInboxIpc({ ipcMain: { handle: (ch, fn) => (handlers[ch] = fn), on: (ch, fn) => (handlers[ch] = fn) }, snapshots: () => null, godmode: { read: () => null, markSeen: async () => true }, machine: 'PC1', now: () => NOW });
  assert.deepEqual(Object.keys(handlers).sort(), ['inbox:open-pr', 'inbox:run']);
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
  });
  return { handlers, marked };
}

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
