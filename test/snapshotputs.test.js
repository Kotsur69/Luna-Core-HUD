// The `repos` / `godmode` puts (src/snapshotputs.js): skipped while logged
// out, and a failing put only logs - it never throws into the caller.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSnapshotPuts } = require('../src/snapshotputs');

const NOW = Date.UTC(2026, 9, 20, 12);

function setup({ loggedIn = true, put } = {}) {
  const puts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-snapputs-'));
  const snapshots = { put: put || (async (kind, data) => (puts.push([kind, data]), true)) };
  const sp = createSnapshotPuts({
    snapshots: () => snapshots,
    loggedIn: () => loggedIn,
    machine: 'PC1',
    readAll: async () => [],
    historyFile: () => path.join(dir, 'runs', 'godmode-snapshot.json'),
    now: () => NOW,
  });
  return { sp, puts, dir };
}

const run = (id, finishedAt = NOW) => ({ id, finishedAt, repoName: 'r', pushed: 1, total: 1, packages: [], approvalSuggestions: [] });

test('repos.after passes rows through and puts a snapshot while logged in', async () => {
  const { sp, puts } = setup();
  const rows = [];
  assert.equal(sp.repos.after(rows), rows);
  await new Promise((r) => setImmediate(r));
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], 'repos');
  assert.equal(await sp.repos.refresh(), true);
});

test('nothing is put while logged out; godmode still keeps its local history', async () => {
  const { sp, puts, dir } = setup({ loggedIn: false });
  sp.repos.after([]);
  assert.equal(await sp.repos.refresh(), false);
  assert.equal(await sp.godmode.add(run('a')), false);
  assert.equal(puts.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'godmode-snapshot.json'), 'utf8'));
  assert.deepEqual(saved.runs.map((r) => r.id), ['a']);
});

test('godmode.add puts the history newest first', async () => {
  const { sp, puts } = setup();
  await sp.godmode.add(run('a', NOW - 1000));
  await sp.godmode.add(run('b'));
  assert.deepEqual(puts.at(-1)[1].runs.map((r) => r.id), ['b', 'a']);
});

test('a failing put logs and resolves false', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const { sp } = setup({
      put: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(await sp.repos.refresh(), false);
    assert.equal(await sp.godmode.add(run('a')), false);
    assert.ok(errors.some((e) => e.includes('[cloudsnapshots] put repos failed')));
    assert.ok(errors.some((e) => e.includes('[cloudsnapshots] put godmode failed')));
  } finally {
    console.error = orig;
  }
});

test('godmode.markSeen stores the id in the own row next to the runs and puts it', async () => {
  const { sp, puts } = setup();
  await sp.godmode.add(run('a'));
  assert.equal(await sp.godmode.markSeen('a'), true);
  assert.equal(await sp.godmode.markSeen('../bad'), false);
  const last = puts.at(-1)[1];
  assert.deepEqual([last.runs.map((r) => r.id), last.seen], [['a'], ['a']]);
  assert.deepEqual(sp.godmode.read().seen, ['a']);
  await sp.godmode.add(run('b'));
  assert.deepEqual(puts.at(-1)[1].seen, ['a'], 'a new run keeps the seen list');
});

test('godmode.lunaswork puts the Luna\'s Work run snapshot as `lunaswork`, cleaned; null clears it (LW 2.17b)', async () => {
  const { sp, puts } = setup();
  const lw = { v: 1, at: NOW, runId: 'lwabc', phase: 'building', milestone: 'see C:\\Users\\mati\\x\\plan.md', iteration: 2 };
  assert.equal(await sp.godmode.lunaswork(lw), true);
  const data = puts.at(-1)[1];
  assert.equal(puts.at(-1)[0], 'godmode');
  assert.equal(data.lunaswork.runId, 'lwabc');
  assert.equal(data.lunaswork.milestone, 'see plan.md');
  // Kept across the other overlay puts.
  await sp.godmode.decisions([]);
  assert.equal(puts.at(-1)[1].lunaswork.runId, 'lwabc');
  await sp.godmode.lunaswork(null);
  assert.equal('lunaswork' in puts.at(-1)[1], false);
  await sp.godmode.lunaswork({ v: 9, runId: 'x' });
  assert.equal('lunaswork' in puts.at(-1)[1], false, 'a malformed snapshot is not put');
});

test('godmode.asks puts the "Ask Luna" answers as `asks`, re-checked; null clears it (LW 2.27)', async () => {
  const { sp, puts } = setup();
  const item = { id: NOW, question: 'why roll back?', status: 'answered', answer: 'iteration 14 broke login', sources: [{ file: 'rollbacks', iteration: 14 }], from: 'phone', at: NOW };
  assert.equal(await sp.godmode.asks({ v: 1, items: [item, { id: 'bad', question: 'x', status: 'answered' }] }), true);
  assert.deepEqual(puts.at(-1)[1].asks, { v: 1, items: [item] });
  // Kept across the other overlay puts.
  await sp.godmode.decisions([]);
  assert.equal(puts.at(-1)[1].asks.items.length, 1);
  await sp.godmode.asks(null);
  assert.equal('asks' in puts.at(-1)[1], false);
  await sp.godmode.asks({ items: 'nope' });
  assert.equal('asks' in puts.at(-1)[1], false, 'nothing valid, nothing put');
});
