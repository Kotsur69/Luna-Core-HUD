// ============================================================================
// LunaCore - forget a PC + collision-free machine keys
// ----------------------------------------------------------------------------
// machineName (src/missionledgersync.js) no longer maps `PC_1` and `PC-1` to
// one key; cloudsnapshots.js lists machines, forgets another PC's rows (never
// this PC's) and migrates this PC's rows from its legacy key once. The fake
// client plays the `snapshots` table.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { machineName, legacyMachineName, machineLabel, MACHINE_RE } = require('../src/missionledgersync.js');
const { createSnapshots, SNAPSHOTS_OFF } = require('../src/cloudsnapshots.js');
const { registerCloudIpc } = require('../src/cloudipc.js');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function fakeTable(initial = []) {
  let rows = initial.map((r) => ({ ...r }));
  const calls = { deletes: [], upserts: [] };
  const key = (r) => `${r.kind}|${r.machine}`;
  const query = (run) => {
    const filters = [];
    const q = {
      eq(col, v) {
        filters.push((r) => r[col] === v);
        return q;
      },
      in(col, vs) {
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      order() {
        return q;
      },
      limit(n) {
        return Promise.resolve(run(rows.filter((r) => filters.every((f) => f(r))), n));
      },
      select() {
        return Promise.resolve(run(rows.filter((r) => filters.every((f) => f(r)))));
      },
      then(res, rej) {
        return Promise.resolve(run(rows.filter((r) => filters.every((f) => f(r))))).then(res, rej);
      },
    };
    return q;
  };
  const client = {
    from(table) {
      assert.equal(table, 'snapshots');
      return {
        select: () => query((hit, n) => ({ data: hit.slice(0, n).map((r) => ({ ...r })), error: null })),
        delete: () =>
          query((hit) => {
            calls.deletes.push(hit.map(key));
            rows = rows.filter((r) => !hit.includes(r));
            return { data: hit.map((r) => ({ kind: r.kind })), error: null };
          }),
        async upsert(input, opts) {
          const list = Array.isArray(input) ? input : [input];
          calls.upserts.push({ list, opts });
          for (const r of list) {
            const at = rows.findIndex((x) => key(x) === key(r));
            if (at >= 0 && opts && opts.ignoreDuplicates) continue;
            if (at >= 0) rows = rows.map((x, i) => (i === at ? { ...r } : x));
            else rows = [...rows, { ...r }];
          }
          return { error: null };
        },
      };
    },
  };
  return { client, calls, rows: () => rows };
}

const snaps = (client, extra = {}) =>
  createSnapshots({ client, machine: 'PC-1-h000000', legacyMachine: 'PC-1', loggedIn: () => true, now: () => NOW, ...extra });

// --- machine keys ---------------------------------------------------------

test('PC_1 and PC-1 get different keys, both valid', () => {
  assert.equal(machineName('PC-1'), 'PC-1');
  const underscored = machineName('PC_1');
  assert.notEqual(underscored, machineName('PC-1'));
  assert.match(underscored, /^PC-1-h[0-9a-f]{6}$/);
  assert.ok(MACHINE_RE.test(underscored));
  // The legacy key is what made them collide.
  assert.equal(legacyMachineName('PC_1'), legacyMachineName('PC-1'));
});

test('machine key is stable, bounded and keeps plain hostnames as they were', () => {
  assert.equal(machineName('PC_1'), machineName('PC_1'));
  assert.equal(machineName('KT-NO-MMAZUR'), 'KT-NO-MMAZUR');
  assert.equal(machineName(''), 'pc');
  const long = machineName(`${'x'.repeat(80)}_y`);
  assert.ok(long.length <= 63 && MACHINE_RE.test(long));
  assert.notEqual(machineName('x'.repeat(64)), machineName('x'.repeat(65)));
});

test('machineLabel shows the normalised name without the hash', () => {
  assert.equal(machineLabel(machineName('PC_1')), 'PC-1');
  assert.equal(machineLabel('KT-PC-LLM'), 'KT-PC-LLM');
});

// --- machines() -------------------------------------------------------------

test('machines lists each machine once with its newest update, own keys marked', async () => {
  const { client } = fakeTable([
    { kind: 'ledger', machine: 'LAPTOP', data: {}, updated_at: iso(NOW - 5000) },
    { kind: 'news', machine: 'LAPTOP', data: {}, updated_at: iso(NOW - 1000) },
    { kind: 'usage', machine: 'PC-1-h000000', data: {}, updated_at: iso(NOW - 2000) },
    { kind: 'usage', machine: 'bad name!', data: {}, updated_at: iso(NOW) },
  ]);
  assert.deepEqual(await snaps(client).machines(), [
    { machine: 'LAPTOP', updatedAt: NOW - 1000, self: false },
    { machine: 'PC-1-h000000', updatedAt: NOW - 2000, self: true },
  ]);
});

// --- forget() ---------------------------------------------------------------

test('forget deletes every row of the chosen machine and nothing else', async () => {
  const t = fakeTable([
    { kind: 'ledger', machine: 'OLD-PC', data: {}, updated_at: iso(NOW) },
    { kind: 'host', machine: 'OLD-PC', data: {}, updated_at: iso(NOW) },
    { kind: 'ledger', machine: 'LAPTOP', data: {}, updated_at: iso(NOW) },
    { kind: 'ledger', machine: 'PC-1-h000000', data: {}, updated_at: iso(NOW) },
  ]);
  assert.deepEqual(await snaps(t.client).forget('OLD-PC'), { ok: true, removed: 2 });
  assert.deepEqual(t.rows().map((r) => r.machine).sort(), ['LAPTOP', 'PC-1-h000000']);
});

test('forget refuses this PC (new or legacy key, any case) and invalid names', async () => {
  const t = fakeTable([{ kind: 'ledger', machine: 'PC-1-h000000', data: {}, updated_at: iso(NOW) }]);
  const s = snaps(t.client);
  for (const own of ['PC-1-h000000', 'pc-1-H000000', 'PC-1', 'pc-1']) {
    assert.deepEqual(await s.forget(own), { ok: false, reason: 'own-machine' }, own);
  }
  for (const bad of ['', 'a b', 'x'.repeat(64), '%', null, 42, { machine: 'X' }]) {
    assert.deepEqual(await s.forget(bad), { ok: false, reason: 'bad-machine' });
  }
  assert.equal(t.calls.deletes.length, 0);
});

test('forget while logged out does nothing', async () => {
  const t = fakeTable([{ kind: 'ledger', machine: 'OLD', data: {}, updated_at: iso(NOW) }]);
  assert.deepEqual(await snaps(t.client, { loggedIn: () => false }).forget('OLD'), { ok: false, reason: 'logged-out' });
  assert.equal(t.rows().length, 1);
  assert.deepEqual(await SNAPSHOTS_OFF.forget('OLD'), { ok: false, reason: 'logged-out' });
});

// --- migrate() / list() -----------------------------------------------------

test('migrate copies legacy rows to the new key, rewrites the body claim, then deletes them', async () => {
  const t = fakeTable([
    { kind: 'ledger', machine: 'PC-1', data: { v: 1, machine: 'PC-1', rows: [] }, updated_at: iso(NOW - 9000) },
    { kind: 'news', machine: 'PC-1', data: { v: 1 }, updated_at: iso(NOW - 8000) },
    { kind: 'ledger', machine: 'LAPTOP', data: { v: 1, machine: 'LAPTOP', rows: [] }, updated_at: iso(NOW) },
  ]);
  assert.equal(await snaps(t.client).migrate(), true);
  const byKey = Object.fromEntries(t.rows().map((r) => [`${r.kind}|${r.machine}`, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ['ledger|LAPTOP', 'ledger|PC-1-h000000', 'news|PC-1-h000000']);
  assert.equal(byKey['ledger|PC-1-h000000'].data.machine, 'PC-1-h000000');
  assert.equal(byKey['ledger|PC-1-h000000'].updated_at, iso(NOW - 9000));
});

test('migrate leaves a legacy row it could not copy', async () => {
  const t = fakeTable([
    { kind: 'ledger', machine: 'PC-1', data: { v: 1 }, updated_at: iso(NOW) },
    { kind: 'future-kind', machine: 'PC-1', data: { v: 9 }, updated_at: iso(NOW) },
  ]);
  assert.equal(await snaps(t.client).migrate(), true);
  assert.deepEqual(t.rows().map((r) => `${r.kind}|${r.machine}`).sort(), ['future-kind|PC-1', 'ledger|PC-1-h000000']);
});

test('migrate keeps a newer row already under the new key', async () => {
  const t = fakeTable([
    { kind: 'ledger', machine: 'PC-1', data: { v: 1, old: true }, updated_at: iso(NOW - 9000) },
    { kind: 'ledger', machine: 'PC-1-h000000', data: { v: 1, fresh: true }, updated_at: iso(NOW) },
  ]);
  await snaps(t.client).migrate();
  assert.deepEqual(t.rows(), [{ kind: 'ledger', machine: 'PC-1-h000000', data: { v: 1, fresh: true }, updated_at: iso(NOW) }]);
});

test('migrate is idempotent and a no-op when the key did not change', async () => {
  const t = fakeTable([{ kind: 'ledger', machine: 'PC-1', data: { v: 1 }, updated_at: iso(NOW) }]);
  const s = snaps(t.client);
  assert.equal(await s.migrate(), true);
  const after = JSON.stringify(t.rows());
  assert.equal(await s.migrate(), true);
  assert.equal(JSON.stringify(t.rows()), after);
  assert.equal(t.calls.upserts.length, 1);
  assert.equal(t.calls.deletes.length, 1);

  const same = fakeTable([{ kind: 'ledger', machine: 'KT', data: {}, updated_at: iso(NOW) }]);
  const plain = createSnapshots({ client: same.client, machine: 'KT', loggedIn: () => true });
  assert.equal(await plain.migrate(), true);
  assert.equal(same.calls.upserts.length + same.calls.deletes.length, 0);
});

// --- IPC ----------------------------------------------------------------------

function ipc(snapshots, loggedIn = true) {
  const handlers = new Map();
  let t = 1_000_000;
  const cloud = { status: () => ({ loggedIn }), snapshots };
  registerCloudIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, cloud, now: () => (t += 10_000) });
  return (ch, arg) => handlers.get(ch)({}, arg);
}

test('cloud:machines answers names, labels and times only', async () => {
  const call = ipc({
    machines: async () => [
      { machine: 'PC-1-habcdef', updatedAt: 5, self: true, data: { secret: 1 } },
      { machine: 'evil name', updatedAt: 6, self: false },
    ],
  });
  assert.deepEqual(await call('cloud:machines'), {
    ok: true,
    machines: [{ machine: 'PC-1-habcdef', label: 'PC-1', updatedAt: 5, self: true }],
  });
  assert.deepEqual(await ipc({ machines: async () => null })('cloud:machines'), { ok: false, reason: 'failed' });
  assert.deepEqual(await ipc({}, false)('cloud:machines'), { ok: false, reason: 'logged-out' });
});

test('cloud:forget validates in main and passes through refusals', async () => {
  const asked = [];
  const call = ipc({
    forget: async (m) => (asked.push(m), m === 'SELF' ? { ok: false, reason: 'own-machine' } : { ok: true, removed: 3, rows: ['x'] }),
  });
  assert.deepEqual(await call('cloud:forget', '../x'), { ok: false, reason: 'bad-machine' });
  assert.deepEqual(await call('cloud:forget', { machine: 'OLD' }), { ok: false, reason: 'bad-machine' });
  assert.deepEqual(await call('cloud:forget', 'SELF'), { ok: false, reason: 'own-machine' });
  assert.deepEqual(await call('cloud:forget', 'OLD'), { ok: true, removed: 3 });
  assert.deepEqual(asked, ['SELF', 'OLD']);
});

test('cloud:forget is rate-limited', async () => {
  const handlers = new Map();
  const cloud = { status: () => ({ loggedIn: true }), snapshots: { forget: async () => ({ ok: true, removed: 0 }) } };
  registerCloudIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, cloud, now: () => 5_000_000 });
  const call = (m) => handlers.get('cloud:forget')({}, m);
  assert.equal((await call('A')).ok, true);
  assert.deepEqual(await call('B'), { ok: false, reason: 'rate-limited' });
});

test('list treats rows under the legacy key as this PC, not a peer', async () => {
  // list() also chains .neq: a minimal client of its own.
  const rows = [
    { machine: 'PC-1', data: { v: 1 }, updated_at: iso(NOW) },
    { machine: 'LAPTOP', data: { v: 1 }, updated_at: iso(NOW) },
  ];
  const listClient = {
    from: () => ({
      select: () => {
        const q = { eq: () => q, neq: () => q, order: () => q, limit: async () => ({ data: rows, error: null }) };
        return q;
      },
    }),
  };
  const got = await snaps(listClient).list('ledger');
  assert.deepEqual(got.map((r) => r.machine), ['LAPTOP']);
});
