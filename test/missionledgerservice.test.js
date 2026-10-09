// ============================================================================
// LunaCore - Mission Control ledger service tests (src/missionledgerservice.js)
// ----------------------------------------------------------------------------
// The ledger, store, sync and rates are injected fakes; the clock is fixed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLedgerService, weekWindow } = require('../src/missionledgerservice.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = Date.parse('2026-10-09T10:00:00Z');
const RATES = { rates: [{ id: 'claude-opus-5-5', input: 4, output: 20 }], cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

function fakes({ sharedDir = null, classes = {}, ownRows, peers = [] } = {}) {
  const writes = [];
  const deps = {
    ledger: {
      scan: async () => {},
      rows: () => ownRows || [[H, 'git:github.com/me/a', 'a', 'claude-opus-5-5', 1e6, 0, 0, 0]],
    },
    store: { loadProjects: () => ({ classes, sharedDir }) },
    sync: {
      writeOwn: (dir, machine, rows, now) => writes.push({ dir, machine, rows, now }),
      readPeers: () => peers,
    },
    loadRates: () => RATES,
    machine: 'HOME',
    now: () => NOW,
  };
  return { deps, writes };
}

test('weekWindow uses the provider reset when it is within the next 7 days', () => {
  const reset = NOW + 2 * DAY;
  assert.deepEqual(weekWindow(reset, NOW), { sinceMs: reset - 7 * DAY, untilMs: NOW, source: 'reset' });
});

test('weekWindow falls back to Monday 00:00 local for a missing or absurd reset', () => {
  for (const bad of [undefined, null, 'x', NOW - DAY, NOW + 30 * DAY, NaN]) {
    const w = weekWindow(bad, NOW);
    const monday = new Date(w.sinceMs);
    assert.equal(w.source, 'monday');
    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getHours(), 0);
    assert.ok(NOW - w.sinceMs < 7 * DAY && w.sinceMs <= NOW);
  }
});

test('report prices this PC alone when no shared folder is set, and writes nothing', async () => {
  const { deps, writes } = fakes({ classes: { 'git:github.com/me/a': 'work' } });
  const r = await createLedgerService(deps).report({ resetsAt: NOW + DAY });
  assert.equal(writes.length, 0);
  assert.equal(r.ok, true);
  assert.equal(r.totalUsd, 4);
  assert.deepEqual(r.machines, [{ machine: 'HOME', updatedAt: NOW, self: true }]);
  assert.equal(r.projects[0].cls, 'work');
  assert.equal(r.sharedDir, null);
  assert.equal(r.windowSource, 'reset');
});

test('report merges peer PCs and writes our own file to the shared folder', async () => {
  const peerRows = [[H, 'git:github.com/me/a', 'a', 'claude-opus-5-5', 1e6, 0, 0, 0], [H, 'local:toy', 'toy', 'claude-opus-5-5', 2e6, 0, 0, 0]];
  const { deps, writes } = fakes({ sharedDir: 'D:\\Sync\\ledger', peers: [{ machine: 'LAPTOP', updatedAt: NOW - HOUR, rows: peerRows }] });
  const r = await createLedgerService(deps).report({});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].dir, 'D:\\Sync\\ledger');
  assert.equal(writes[0].machine, 'HOME');
  assert.equal(r.totalUsd, 16);
  assert.deepEqual(
    r.projects.map((p) => [p.key, p.usd, p.cls]),
    [
      ['git:github.com/me/a', 8, null],
      ['local:toy', 8, null],
    ]
  );
  assert.deepEqual(r.machines.map((m) => m.machine), ['HOME', 'LAPTOP']);
});

test('a failing shared-folder write still returns the report, flagged', async () => {
  const { deps } = fakes({ sharedDir: 'Z:\\gone' });
  deps.sync.writeOwn = () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  const r = await createLedgerService(deps).report({});
  assert.equal(r.ok, true);
  assert.equal(r.syncError, 'ENOENT');
});

test('the own file is not rewritten when the rows did not change', async () => {
  const { deps, writes } = fakes({ sharedDir: 'D:\\Sync' });
  const svc = createLedgerService(deps);
  await svc.report({});
  await svc.report({});
  assert.equal(writes.length, 1);
});

test('report returns at most MAX_PROJECTS projects and counts the rest', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => [H, `local:p${i}`, `p${i}`, 'claude-opus-5-5', 1000 + i, 0, 0, 0]);
  const { deps } = fakes({ ownRows: rows });
  const { MAX_PROJECTS } = require('../src/missionledgerservice.js');
  const r = await createLedgerService(deps).report({});
  assert.equal(r.projects.length, MAX_PROJECTS);
  assert.equal(r.moreProjects, 80 - MAX_PROJECTS);
  assert.equal(r.projects[0].key, 'local:p79', 'biggest first');
});

test('pinned projects are always reported, at zero when idle, and flagged', async () => {
  const { deps } = fakes();
  deps.store.loadProjects = () => ({
    classes: { 'git:github.com/me/idle': 'fun' },
    sharedDir: null,
    pinned: [
      { key: 'git:github.com/me/idle', name: 'idle', folders: [] },
      { key: 'git:github.com/me/a', name: 'a', folders: [] },
    ],
  });
  const r = await createLedgerService(deps).report({});
  const idle = r.projects.find((p) => p.key === 'git:github.com/me/idle');
  assert.deepEqual([idle.usd, idle.pinned, idle.cls], [0, true, 'fun']);
  assert.equal(r.projects.find((p) => p.key === 'git:github.com/me/a').pinned, true);
});
