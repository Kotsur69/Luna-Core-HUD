// ============================================================================
// LunaCore - cloud snapshots (src/cloudsnapshots.js)
// ----------------------------------------------------------------------------
// One row per (kind, machine) in the `snapshots` table: put() upserts this
// PC's row only when its content changed, list() reads the other machines'
// rows through a short cache. The fake client plays the table.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSnapshots, MAX_BYTES, TTL_MS } = require('../src/cloudsnapshots.js');

function fakeClient() {
  const rows = new Map(); // `${kind}|${machine}` -> row
  const calls = { upserts: [], selects: 0 };
  let fail = false;
  let hold = null; // a promise every call waits on, to stage races
  const gate = () => hold || Promise.resolve();
  const client = {
    from(table) {
      assert.equal(table, 'snapshots');
      return {
        async upsert(row, opts) {
          calls.upserts.push({ row, opts });
          await gate();
          if (fail) return { error: { message: 'offline' } };
          rows.set(`${row.kind}|${row.machine}`, { ...row });
          return { error: null };
        },
        select(cols) {
          assert.equal(cols, 'machine,data,updated_at');
          let kind = null;
          let notMachine = null;
          let newestFirst = false;
          const q = {
            eq(col, v) {
              assert.equal(col, 'kind');
              kind = v;
              return q;
            },
            neq(col, v) {
              assert.equal(col, 'machine');
              notMachine = v;
              return q;
            },
            order(col, opts) {
              assert.equal(col, 'updated_at');
              newestFirst = opts && opts.ascending === false;
              return q;
            },
            async limit(n) {
              calls.selects++;
              await gate();
              if (fail) return { data: null, error: { message: 'offline' } };
              const out = [...rows.values()].filter((r) => r.kind === kind && r.machine !== notMachine);
              if (newestFirst) out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              return { data: out.slice(0, n), error: null };
            },
          };
          return q;
        },
      };
    },
  };
  /** Holds every call until the returned release() runs. */
  const pause = () => {
    let release;
    hold = new Promise((r) => (release = r));
    return () => {
      hold = null;
      release();
    };
  };
  return { client, rows, calls, setFail: (v) => (fail = v), pause };
}

function setup({ loggedIn = true } = {}) {
  const srv = fakeClient();
  let t = Date.parse('2026-10-16T00:00:00Z');
  let online = loggedIn;
  const snaps = createSnapshots({ client: srv.client, machine: 'HOME', loggedIn: () => online, now: () => t });
  return { srv, snaps, tick: (ms) => (t += ms), setLoggedIn: (v) => (online = v) };
}

test("put upserts this machine's row, keyed on the primary key", async () => {
  const { srv, snaps } = setup();
  assert.equal(await snaps.put('ledger', { a: 1 }), true);
  assert.equal(srv.calls.upserts.length, 1);
  const { row, opts } = srv.calls.upserts[0];
  assert.deepEqual({ kind: row.kind, machine: row.machine, data: row.data }, { kind: 'ledger', machine: 'HOME', data: { a: 1 } });
  assert.equal(typeof row.updated_at, 'string');
  assert.equal(opts.onConflict, 'user_id,kind,machine');
});

test('put skips an unchanged snapshot, and retries one that failed', async () => {
  const { srv, snaps } = setup();
  await snaps.put('ledger', { a: 1 });
  await snaps.put('ledger', { a: 1 });
  assert.equal(srv.calls.upserts.length, 1);
  srv.setFail(true);
  assert.equal(await snaps.put('ledger', { a: 2 }), false);
  srv.setFail(false);
  assert.equal(await snaps.put('ledger', { a: 2 }), true);
  assert.equal(srv.calls.upserts.length, 3);
});

test('put refuses unknown kinds, non-objects and oversize data without a call', async () => {
  const { srv, snaps } = setup();
  assert.equal(await snaps.put('secrets', { a: 1 }), false);
  assert.equal(await snaps.put('ledger', [1, 2]), false);
  assert.equal(await snaps.put('ledger', null), false);
  assert.equal(await snaps.put('ledger', { big: 'x'.repeat(MAX_BYTES) }), false);
  assert.equal(srv.calls.upserts.length, 0);
});

test('logged out: put and list do nothing', async () => {
  const { srv, snaps } = setup({ loggedIn: false });
  assert.equal(await snaps.put('ledger', { a: 1 }), false);
  assert.deepEqual(await snaps.list('ledger'), []);
  assert.equal(srv.calls.upserts.length + srv.calls.selects, 0);
});

test('list returns the other machines only (case-insensitive), with updatedAt in ms', async () => {
  const { srv, snaps } = setup();
  srv.rows.set('ledger|WORK', { kind: 'ledger', machine: 'WORK', data: { x: 1 }, updated_at: '2026-10-15T10:00:00Z' });
  srv.rows.set('ledger|home', { kind: 'ledger', machine: 'home', data: { x: 2 }, updated_at: '2026-10-15T10:00:00Z' });
  srv.rows.set('news|WORK', { kind: 'news', machine: 'WORK', data: { y: 1 }, updated_at: '2026-10-15T10:00:00Z' });
  assert.deepEqual(await snaps.list('ledger'), [{ machine: 'WORK', data: { x: 1 }, updatedAt: Date.parse('2026-10-15T10:00:00Z') }]);
});

test('list drops rows with a bad machine name or non-object data', async () => {
  const { srv, snaps } = setup();
  srv.rows.set('ledger|a', { kind: 'ledger', machine: '../x', data: { x: 1 }, updated_at: null });
  srv.rows.set('ledger|b', { kind: 'ledger', machine: 'OK', data: 'nope', updated_at: null });
  srv.rows.set('ledger|c', { kind: 'ledger', machine: 'GOOD', data: { x: 1 }, updated_at: 'garbage' });
  assert.deepEqual(await snaps.list('ledger'), [{ machine: 'GOOD', data: { x: 1 }, updatedAt: 0 }]);
});

test('list is cached for TTL_MS; a failure keeps the last good answer', async () => {
  const { srv, snaps, tick } = setup();
  srv.rows.set('ledger|WORK', { kind: 'ledger', machine: 'WORK', data: { x: 1 }, updated_at: null });
  await snaps.list('ledger');
  await snaps.list('ledger');
  assert.equal(srv.calls.selects, 1);
  tick(TTL_MS + 1);
  srv.setFail(true);
  assert.equal((await snaps.list('ledger')).length, 1);
  assert.equal(srv.calls.selects, 2);
});

test('list of an unknown kind is empty without a call', async () => {
  const { srv, snaps } = setup();
  assert.deepEqual(await snaps.list('secrets'), []);
  assert.equal(srv.calls.selects, 0);
});

test('reset forgets the cache and what was put', async () => {
  const { srv, snaps } = setup();
  srv.rows.set('ledger|WORK', { kind: 'ledger', machine: 'WORK', data: { x: 1 }, updated_at: null });
  await snaps.put('ledger', { a: 1 });
  await snaps.list('ledger');
  snaps.reset();
  await snaps.put('ledger', { a: 1 });
  await snaps.list('ledger');
  assert.equal(srv.calls.upserts.length, 2);
  assert.equal(srv.calls.selects, 2);
});

test('a list still in flight at reset() does not fill the next user\'s cache', async () => {
  const { srv, snaps } = setup();
  srv.rows.set('ledger|WORK', { kind: 'ledger', machine: 'WORK', data: { x: 1 }, updated_at: null });
  const release = srv.pause();
  const old = snaps.list('ledger');
  snaps.reset();
  release();
  assert.deepEqual(await old, []);
  srv.rows.clear();
  assert.deepEqual(await snaps.list('ledger'), []);
  assert.equal(srv.calls.selects, 2);
});

test('a put still in flight at reset() does not make the next user skip the same snapshot', async () => {
  const { srv, snaps } = setup();
  const release = srv.pause();
  const old = snaps.put('ledger', { a: 1 });
  snaps.reset();
  release();
  assert.equal(await old, false);
  assert.equal(await snaps.put('ledger', { a: 1 }), true);
  // The new user's put really reached the server (the old one never got there).
  assert.deepEqual(srv.rows.get('ledger|HOME').data, { a: 1 });
  assert.equal(srv.calls.upserts.length, 1);
});

test('puts of one kind run one at a time, in order', async () => {
  const { srv, snaps } = setup();
  const release = srv.pause();
  const first = snaps.put('ledger', { a: 1 });
  const second = snaps.put('ledger', { a: 2 });
  await Promise.resolve();
  assert.equal(srv.calls.upserts.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(srv.calls.upserts.map((c) => c.row.data.a), [1, 2]);
  assert.deepEqual(srv.rows.get('ledger|HOME').data, { a: 2 });
});

test('list asks for the newest rows, skips our own server-side and clamps a future updated_at', async () => {
  const { srv, snaps } = setup();
  srv.rows.set('ledger|HOME', { kind: 'ledger', machine: 'HOME', data: { x: 0 }, updated_at: '2026-10-15T00:00:00Z' });
  srv.rows.set('ledger|FAR', { kind: 'ledger', machine: 'FAR', data: { x: 1 }, updated_at: '2099-01-01T00:00:00Z' });
  const rows = await snaps.list('ledger');
  assert.deepEqual(rows.map((r) => r.machine), ['FAR']);
  assert.equal(rows[0].updatedAt, Date.parse('2026-10-16T00:00:00Z'));
});

test('fits() says whether data is within MAX_BYTES', () => {
  const { fits } = require('../src/cloudsnapshots.js');
  assert.equal(fits({ a: 1 }), true);
  assert.equal(fits({ big: 'x'.repeat(MAX_BYTES) }), false);
});
