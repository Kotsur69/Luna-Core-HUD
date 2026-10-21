// ============================================================================
// LunaCore - Mission Control ledger service tests (src/missionledgerservice.js)
// ----------------------------------------------------------------------------
// The ledger, store, cloud and rates are injected fakes; the clock is fixed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLedgerService, weekWindow } = require('../src/missionledgerservice.js');
const { parsePeer } = require('../src/missionledgersync.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = Date.parse('2026-10-09T10:00:00Z');
const RATES = { rates: [{ id: 'claude-opus-5-5', input: 4, output: 20 }], cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

function fakes({ classes = {}, ownRows, ownEvents = [] } = {}) {
  const deps = {
    ledger: {
      scan: async () => {},
      rows: () => ownRows || [[H, 'git:github.com/me/a', 'a', 'claude-opus-5-5', 1e6, 0, 0, 0]],
      events: () => ownEvents,
    },
    store: { loadProjects: () => ({ classes }) },
    sync: { parsePeer },
    loadRates: () => RATES,
    machine: 'HOME',
    now: () => NOW,
  };
  return { deps };
}

/** Adds a fake cloud: `cloudRows` are other PCs' `ledger` snapshot rows; `puts` records ours. */
function withCloud(deps, cloudRows = []) {
  const puts = [];
  const cloud = {
    put: async (kind, data) => {
      puts.push({ kind, data });
      return true;
    },
    list: async (kind) => (kind === 'ledger' ? cloudRows : []),
  };
  return { deps: { ...deps, cloud }, puts };
}

/** A peer PC's snapshot row as cloud.list('ledger') returns it. */
const peerRow = (machine, updatedAt, rows, blocks = []) => ({ machine, updatedAt, data: { v: 1, machine, rows, blocks } });

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

test('report prices this PC alone when the cloud is off', async () => {
  const { deps } = fakes({ classes: { 'git:github.com/me/a': 'work' } });
  const r = await createLedgerService(deps).report({ resetsAt: NOW + DAY });
  assert.equal(r.ok, true);
  assert.equal(r.totalUsd, 4);
  assert.deepEqual(r.machines, [{ machine: 'HOME', updatedAt: NOW, self: true }]);
  assert.equal(r.projects[0].cls, 'work');
  assert.equal('sharedDir' in r, false);
  assert.equal(r.windowSource, 'reset');
});

test('report merges peer PCs from the cloud', async () => {
  const peerRows = [[H, 'git:github.com/me/a', 'a', 'claude-opus-5-5', 1e6, 0, 0, 0], [H, 'local:toy', 'toy', 'claude-opus-5-5', 2e6, 0, 0, 0]];
  const { deps } = withCloud(fakes().deps, [peerRow('LAPTOP', NOW - HOUR, peerRows)]);
  const r = await createLedgerService(deps).report({});
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

// ---- Focus / time per project (W2) ----

const MIN = 60 * 1000;
// Local Monday of NOW's week, 09:00 - built in local time like missionfocus.js.
const nowDate = new Date(NOW);
const MON9 = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - ((nowDate.getDay() + 6) % 7), 9).getTime();

test("report adds this week's focus from Claude replies and commits, with classes", async () => {
  const { deps, puts } = withCloud(
    fakes({
      classes: { 'git:github.com/me/a': 'work' },
      ownEvents: [
        { ms: MON9, key: 'git:github.com/me/a', name: 'a' },
        { ms: MON9 + 5 * MIN, key: 'git:github.com/me/a', name: 'a' },
      ],
    }).deps
  );
  deps.commits = { events: async () => [{ ms: MON9 + 60 * MIN, key: 'local:toy', name: 'toy' }] };
  const r = await createLedgerService(deps).report({});
  assert.deepEqual(
    r.focus.projects.map((p) => [p.key, p.totalMs, p.cls]),
    [
      ['git:github.com/me/a', 10 * MIN, 'work'],
      ['local:toy', 5 * MIN, null],
    ]
  );
  assert.equal(r.focus.totalMs, 15 * MIN);
  assert.equal(r.focus.days.length, 7);
  assert.deepEqual(puts[0].data.blocks, [
    [MON9, MON9 + 10 * MIN, 'git:github.com/me/a', 'a'],
    [MON9 + 60 * MIN, MON9 + 65 * MIN, 'local:toy', 'toy'],
  ]);
});

test("focus unions a peer PC's blocks with ours (the same hour is not counted twice)", async () => {
  const { deps } = withCloud(fakes({ ownEvents: [{ ms: MON9, key: 'git:github.com/me/a', name: 'a' }] }).deps, [
    peerRow('LAPTOP', NOW, [], [[MON9, MON9 + 60 * MIN, 'git:github.com/me/a', 'a']]),
  ]);
  const r = await createLedgerService(deps).report({});
  assert.equal(r.focus.projects[0].totalMs, 60 * MIN);
});

test('a failing commit reader leaves focus with the Claude replies only', async () => {
  const { deps } = fakes({ ownEvents: [{ ms: MON9, key: 'git:github.com/me/a', name: 'a' }] });
  deps.commits = { events: async () => Promise.reject(new Error('git gone')) };
  const r = await createLedgerService(deps).report({});
  assert.equal(r.ok, true);
  assert.equal(r.focus.projects[0].totalMs, 5 * MIN);
});

test('report.commitDays counts my commits per local day with feat/fix (last 14 days)', async () => {
  const { deps } = fakes();
  const today = new Date(NOW);
  const at = (daysBack, h) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack, h).getTime();
  deps.commits = {
    events: async () => [],
    shipped: async () => [
      { ms: at(0, 9), key: 'local:a', kind: 'feat' },
      { ms: at(0, 10), key: 'local:a', kind: 'fix' },
      { ms: at(0, 11), key: 'local:a', kind: '' },
      { ms: at(1, 9), key: 'local:a', kind: '' },
      { ms: at(20, 9), key: 'local:a', kind: 'feat' },
    ],
  };
  const r = await createLedgerService(deps).report({});
  assert.equal(r.commitDays.length, 14);
  assert.deepEqual(r.commitDays[13], { date: r.commitDays[13].date, commits: 3, feat: 1, fix: 1 });
  assert.equal(r.commitDays[12].commits, 1);
  assert.equal(r.commitDays.reduce((s, d) => s + d.commits, 0), 4);
});

test('report.commitDays is null without a commit reader that knows kinds', async () => {
  const r = await createLedgerService(fakes().deps).report({});
  assert.equal(r.commitDays, null);
});

test("report.focus.prevDays holds last week's daily totals", async () => {
  const { deps } = fakes({ ownEvents: [{ ms: MON9 - 7 * DAY, key: 'git:github.com/me/a', name: 'a' }] });
  const r = await createLedgerService(deps).report({});
  assert.equal(r.focus.prevDays.length, 7);
  assert.equal(r.focus.prevDays.reduce((s, d) => s + d.totalMs, 0), 5 * MIN);
});

test('report.now = the project of the latest Claude reply under 10 min old, with its block start', async () => {
  const live = [
    { ms: NOW - 40 * MIN, key: 'git:github.com/me/b', name: 'b' },
    { ms: NOW - 20 * MIN, key: 'git:github.com/me/a', name: 'a' },
    { ms: NOW - 12 * MIN, key: 'git:github.com/me/a', name: 'a' },
    { ms: NOW - 3 * MIN, key: 'git:github.com/me/a', name: 'a' },
  ];
  const r = await createLedgerService(fakes({ ownEvents: live }).deps).report({});
  assert.deepEqual(r.now, { key: 'git:github.com/me/a', name: 'a', sinceMs: NOW - 20 * MIN, lastMs: NOW - 3 * MIN });
  const stale = await createLedgerService(fakes({ ownEvents: [{ ms: NOW - 11 * MIN, key: 'x', name: 'x' }] }).deps).report({});
  assert.equal(stale.now, null);
});

// ---- Cloud snapshot (docs/CLOUD_SYNC_PLAN.md, 2c) ----

test('with the cloud on, our rows go up and other PCs come down', async () => {
  const peer = { v: 1, machine: 'WORK', rows: [[H, 'local:toy', 'toy', 'claude-opus-5-5', 2e6, 0, 0, 0]], blocks: [] };
  const { deps, puts } = withCloud(fakes().deps, [{ machine: 'WORK', data: peer, updatedAt: NOW - HOUR }]);
  const r = await createLedgerService(deps).report({});
  assert.equal(puts.length, 1);
  assert.equal(puts[0].kind, 'ledger');
  assert.equal(puts[0].data.machine, 'HOME');
  assert.equal('updatedAt' in puts[0].data, false); // the row's updated_at says when; same rows = same snapshot
  assert.equal(r.totalUsd, 12);
  assert.deepEqual(r.machines, [
    { machine: 'HOME', updatedAt: NOW, self: true },
    { machine: 'WORK', updatedAt: NOW - HOUR, self: false },
  ]);
});

test('the cloud snapshot keeps only the last 8 days of rows and blocks', async () => {
  const old = NOW - 10 * DAY - (NOW % HOUR);
  const ownRows = [[H, 'local:a', 'a', 'claude-opus-5-5', 1, 0, 0, 0], [old, 'local:a', 'a', 'claude-opus-5-5', 1, 0, 0, 0]];
  const { deps, puts } = withCloud(fakes({ ownRows }).deps);
  await createLedgerService(deps).report({});
  assert.deepEqual(puts[0].data.rows.map((r) => r[0]), [H]);
});

test('two snapshot rows of the same PC (case differs) count once, the newer one wins', async () => {
  const { deps } = withCloud(fakes().deps, [
    peerRow('WORK', NOW - 3 * HOUR, [[H, 'local:toy', 'toy', 'claude-opus-5-5', 1e6, 0, 0, 0]]),
    peerRow('work', NOW - HOUR, [[H, 'local:toy', 'toy', 'claude-opus-5-5', 2e6, 0, 0, 0]]),
  ]);
  const r = await createLedgerService(deps).report({});
  assert.equal(r.totalUsd, 12);
  assert.equal(r.machines.length, 2);
});

test('a malformed cloud peer is dropped, and our own machine never counts twice', async () => {
  const { deps } = withCloud(fakes().deps, [
    { machine: 'WORK', data: { v: 1, machine: 'OTHER', rows: [] }, updatedAt: NOW },
    { machine: 'HOME', data: { v: 1, machine: 'HOME', rows: [[H, 'local:a', 'a', 'claude-opus-5-5', 9e6, 0, 0, 0]] }, updatedAt: NOW },
  ]);
  const r = await createLedgerService(deps).report({});
  assert.equal(r.totalUsd, 4);
  assert.equal(r.machines.length, 1);
});

test('a failing cloud never breaks the report', async () => {
  const { deps } = withCloud(fakes().deps);
  deps.cloud.put = async () => {
    throw new Error('offline');
  };
  deps.cloud.list = async () => {
    throw new Error('offline');
  };
  const r = await createLedgerService(deps).report({});
  assert.equal(r.ok, true);
  assert.equal(r.totalUsd, 4);
});

test('a heavy week that does not fit one snapshot row is cut to the newest days', async () => {
  const { MAX_BYTES } = require('../src/cloudsnapshots.js');
  const name = 'n'.repeat(90);
  const rows = [];
  for (let h = 0; rows.length * 140 < MAX_BYTES * 1.5; h++) {
    rows.push([H - (h % (7 * 24)) * HOUR, `local:p${rows.length}`, name, 'claude-opus-5-5', 1, 0, 0, 0]);
  }
  const { deps, puts } = withCloud(fakes({ ownRows: rows }).deps);
  await createLedgerService(deps).report({});
  const sent = puts[0].data.rows;
  assert.ok(sent.length > 0 && sent.length < rows.length);
  assert.ok(sent.every((r) => r[0] >= NOW - 3 * DAY));
});

test('a cloud peer with nothing left in range is not listed as a PC', async () => {
  const { deps } = withCloud(fakes().deps, [{ machine: 'OLD', data: { v: 1, machine: 'OLD', rows: [], blocks: [] }, updatedAt: NOW - 30 * DAY }]);
  const r = await createLedgerService(deps).report({});
  assert.equal(r.machines.length, 1);
});

// --- range(): the weekly review's week, the brief's weekend ----------------------

test('range prices rows and clips focus hours to the window, with classes, uploading nothing', async () => {
  const ownEvents = [
    { ms: H - 2 * HOUR, key: 'git:github.com/me/a', name: 'a' },
    { ms: H + 5 * 60 * 1000, key: 'git:github.com/me/a', name: 'a' },
  ];
  const { deps } = fakes({ classes: { 'git:github.com/me/a': 'fun' }, ownEvents });
  const { deps: withC, puts } = withCloud(deps);
  const res = await createLedgerService(withC).range({ sinceMs: H, untilMs: H + 2 * HOUR });
  assert.equal(res.ok, true);
  assert.equal(res.projects[0].cls, 'fun');
  assert.ok(res.totalUsd > 0);
  // The block [H+5min, H+10min] is inside; the one 2 h before is not.
  assert.deepEqual(res.hours.map((p) => [p.key, p.ms, p.cls]), [['git:github.com/me/a', 5 * 60 * 1000, 'fun']]);
  assert.equal(puts.length, 0);
});

test('range refuses an empty, reversed or over-long window', async () => {
  const svc = createLedgerService(fakes().deps);
  for (const req of [null, {}, { sinceMs: H, untilMs: H }, { sinceMs: H, untilMs: H - 1 }, { sinceMs: H, untilMs: H + 9 * DAY }]) {
    assert.deepEqual(await svc.range(req), { ok: false, reason: 'bad-range' });
  }
});
