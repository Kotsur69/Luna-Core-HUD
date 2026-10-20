// ============================================================================
// LunaCore - YAZIO Body data over the cloud (src/lifeyaziopeers.js)
// ----------------------------------------------------------------------------
// A PC logged in to YAZIO puts its Body data as the `yazio` snapshot; a PC
// that is not logged in shows the newest other PC's copy. The row is
// untrusted: only the known numeric fields survive, in sane ranges.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { yazioSnapshot, parseYazioPeer, newestYazioPeer } = require('../src/lifeyaziopeers.js');
const { registerLifeIpc } = require('../src/lifeipc.js');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const TODAY = {
  kcal: 1200,
  kcalGoal: 2200,
  activityKcal: 300,
  protein: 80,
  proteinGoal: 150,
  fat: 40,
  fatGoal: 70,
  carb: 120,
  carbGoal: 250,
  steps: 6000,
  stepsGoal: 10000,
  water: 1500,
  waterGoal: 2500,
  weight: 82.4,
  startWeight: 90,
  weightGoal: 78,
};

function bodyData(over = {}) {
  return {
    date: '2026-10-15',
    today: { ...TODAY },
    history: [
      { date: '2026-10-14', kcal: 2100, kcalGoal: 2200, protein: 140, steps: 9000 },
      { date: '2026-10-15', kcal: 1200, kcalGoal: 2200, protein: 80, steps: 6000 },
    ],
    lastWeighIn: { value: 82.4, date: '2026-10-15' },
    fetchedAt: NOW - 60000,
    ...over,
  };
}

const row = (data, machine = 'KT-PC-LLM', updatedAt = NOW - 1000) => ({ machine, data, updatedAt });

test('yazioSnapshot -> parseYazioPeer round-trips the Body data', () => {
  const snap = yazioSnapshot(bodyData(), NOW);
  assert.equal(snap.v, 1);
  const peer = parseYazioPeer(row(snap), NOW);
  assert.equal(peer.machine, 'KT-PC-LLM');
  assert.deepEqual(peer.body, bodyData());
});

test('parseYazioPeer: wrong version or shape -> null', () => {
  assert.equal(parseYazioPeer(row({ v: 2, body: bodyData() }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData({ date: '15.10.2026' }) }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData({ today: null }) }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData({ today: { ...TODAY, kcal: 'lots' } }) }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData({ today: { ...TODAY, steps: -5 } }) }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData({ history: 'x' }) }), NOW), null);
  assert.equal(parseYazioPeer(row({ v: 1, body: bodyData() }, '../evil'), NOW), null);
  assert.equal(parseYazioPeer(null, NOW), null);
});

test('parseYazioPeer: unknown fields dropped, ranges enforced, future time clamped', () => {
  const data = bodyData({
    today: { ...TODAY, weight: null, injected: '<script>' },
    history: Array.from({ length: 100 }, () => ({ date: '2026-10-15', kcal: 1, kcalGoal: 2, protein: 3, steps: 4, x: 'y' })),
    lastWeighIn: { value: 'heavy', date: '2026-10-15' },
    fetchedAt: NOW + 10 * 86400000,
    extra: 'nope',
  });
  const { body } = parseYazioPeer(row({ v: 1, body: data }), NOW);
  assert.equal(body.today.weight, null);
  assert.equal('injected' in body.today, false);
  assert.equal('extra' in body, false);
  assert.ok(body.history.length <= 31);
  assert.equal('x' in body.history[0], false);
  assert.equal(body.lastWeighIn, null);
  assert.equal(body.fetchedAt, NOW);
});

test('newestYazioPeer: the most recently fetched valid copy wins; cloud off or failing -> null', async () => {
  const rows = [
    row({ v: 1, body: bodyData({ fetchedAt: NOW - 5000 }) }, 'OLD-PC'),
    row({ v: 1, body: bodyData({ fetchedAt: NOW - 1000 }) }, 'KT-PC-LLM'),
    row({ v: 7 }, 'BAD-PC'),
  ];
  const peer = await newestYazioPeer(() => ({ list: async (kind) => (kind === 'yazio' ? rows : []) }), NOW);
  assert.equal(peer.machine, 'KT-PC-LLM');
  assert.equal(await newestYazioPeer(() => null, NOW), null);
  assert.equal(await newestYazioPeer(() => ({ list: async () => { throw new Error('offline'); } }), NOW), null);
});

// ---- IPC ---------------------------------------------------------------------

function harness({ connected, cloud }) {
  const handlers = new Map();
  const yazio = {
    status: () => ({ connected }),
    body: async () => bodyData(),
  };
  registerLifeIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, now: () => NOW, yazio, cloud });
  return (ch, arg) => handlers.get(ch)({}, arg);
}

test('life:body on a PC logged in to YAZIO puts the snapshot', async () => {
  const puts = [];
  const invoke = harness({ connected: true, cloud: () => ({ put: async (k, d) => puts.push([k, d]) || true, list: async () => [] }) });
  const res = await invoke('life:body', {});
  assert.equal(res.connected, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(puts, [['yazio', yazioSnapshot(bodyData(), NOW)]]);
});

test('life:body: a failing cloud put never fails the Body tab', async () => {
  const invoke = harness({ connected: true, cloud: () => ({ put: async () => { throw new Error('offline'); } }) });
  const res = await invoke('life:body', {});
  assert.deepEqual([res.ok, res.connected], [true, true]);
});

test("life:body on a PC without YAZIO shows another PC's copy", async () => {
  const invoke = harness({ connected: false, cloud: () => ({ list: async () => [row(yazioSnapshot(bodyData(), NOW))] }) });
  const res = await invoke('life:body', {});
  assert.equal(res.ok, true);
  assert.equal(res.connected, false);
  assert.deepEqual(res.body, bodyData());
  assert.deepEqual(res.from, { machine: 'KT-PC-LLM' });
});

test('life:body without YAZIO and without a cloud copy: just not connected', async () => {
  const invoke = harness({ connected: false, cloud: () => null });
  assert.deepEqual(await invoke('life:body', {}), { ok: true, connected: false });
});

test('life:body: a body that fails validation is not uploaded over a good row', async () => {
  const puts = [];
  const handlers = new Map();
  const yazio = { status: () => ({ connected: true }), body: async () => bodyData({ date: 'broken' }) };
  const cloud = () => ({ put: async (k, d) => puts.push([k, d]) || true, list: async () => [] });
  registerLifeIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, now: () => NOW, yazio, cloud });
  await handlers.get('life:body')({}, {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(puts, []);
});

test('life:body without YAZIO: a stalled cloud falls back to not connected', async () => {
  const handlers = new Map();
  const yazio = { status: () => ({ connected: false }) };
  const cloud = () => ({ list: () => new Promise(() => {}) });
  registerLifeIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, now: () => NOW, yazio, cloud, peerTimeoutMs: 20 });
  assert.deepEqual(await handlers.get('life:body')({}, {}), { ok: true, connected: false });
});

test('background refresh: a logged-in PC fetches and puts the snapshot on its own', async () => {
  const puts = [];
  let calls = 0;
  const yazio = { status: () => ({ connected: true }), body: async () => (calls++, bodyData()) };
  const cloud = () => ({ put: async (k, d) => puts.push([k, d]) || true, list: async () => [] });
  const life = registerLifeIpc({ ipcMain: { handle: () => {} }, now: () => NOW, yazio, cloud, bodyEveryMs: 10 });
  await new Promise((r) => setTimeout(r, 80));
  life.stop();
  assert.ok(calls >= 2, `fetched ${calls}x`);
  assert.deepEqual(puts[0], ['yazio', yazioSnapshot(bodyData(), NOW)]);
});

test('background refresh: not logged in -> no fetch; a failing fetch never throws; 0 turns it off', async () => {
  let calls = 0;
  const off = { status: () => ({ connected: false }), body: async () => calls++ };
  const failing = { status: () => ({ connected: true }), body: async () => { calls++; throw Object.assign(new Error('x'), { reason: 'network' }); } };
  const a = registerLifeIpc({ ipcMain: { handle: () => {} }, now: () => NOW, yazio: off, bodyEveryMs: 10 });
  const b = registerLifeIpc({ ipcMain: { handle: () => {} }, now: () => NOW, yazio: failing, bodyEveryMs: 10 });
  const c = registerLifeIpc({ ipcMain: { handle: () => {} }, now: () => NOW, yazio: failing, bodyEveryMs: 0 });
  await new Promise((r) => setTimeout(r, 25));
  a.stop();
  b.stop();
  c.stop();
  assert.ok(calls >= 1, 'the failing PC still tried');
  const after = calls;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(calls, after, 'stop() ends the timer');
});
