// ============================================================================
// LunaCore - cloud transport (src/cloudsync.js)
// ----------------------------------------------------------------------------
// Pull by `rev` in pages, push only what the cloud lacks, in batches the
// server accepts, and move the cursor / `pushed` only after success. The
// fake client below plays the Supabase table + push_units RPC.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCloudSync, PAGE, BATCH, SCOPES } = require('../src/cloudsync.js');

/** In-memory sync_units with the same newest-wins rule as the SQL function. */
function fakeServer() {
  const rows = new Map(); // `${scope}|${key}` -> row
  let rev = 0;
  const calls = { pulls: 0, pushes: [] };
  let failPush = false;
  let failPull = false;

  function select(scope, cursor, limit) {
    calls.pulls++;
    if (failPull) return { data: null, error: { message: 'offline' } };
    const data = [...rows.values()]
      .filter((r) => r.scope === scope && r.rev > cursor)
      .sort((a, b) => a.rev - b.rev)
      .slice(0, limit)
      // bigint columns come back as strings sometimes; prove it does not matter.
      .map((r) => ({ key: r.key, value: r.value, u: String(r.u), deleted_at: r.deleted_at, rev: r.rev, machine: r.machine }));
    return { data, error: null };
  }

  const client = {
    from(table) {
      assert.equal(table, 'sync_units');
      const q = { scope: null, cursor: 0, limit: 1e9 };
      const chain = {
        select: () => chain,
        eq: (col, v) => (assert.equal(col, 'scope'), (q.scope = v), chain),
        gt: (col, v) => (assert.equal(col, 'rev'), (q.cursor = v), chain),
        order: () => chain,
        limit: (n) => ((q.limit = n), chain),
        then: (res, rej) => Promise.resolve(select(q.scope, q.cursor, q.limit)).then(res, rej),
      };
      return chain;
    },
    async rpc(name, args) {
      assert.equal(name, 'push_units');
      calls.pushes.push(args);
      if (failPush) return { data: null, error: { message: 'offline' } };
      if (args.p_units.length > 500) return { data: null, error: { message: 'too many' } };
      for (const x of args.p_units) {
        const id = `${args.p_scope}|${x.k}`;
        const cur = rows.get(id);
        if (cur && !(x.u > cur.u)) continue;
        rows.set(id, { scope: args.p_scope, key: x.k, value: x.v, u: x.u, deleted_at: x.d, machine: args.p_machine, rev: ++rev });
      }
      return { data: null, error: null };
    },
  };
  return {
    client,
    calls,
    rows,
    setFailPush: (v) => (failPush = v),
    setFailPull: (v) => (failPull = v),
    /** A row written by another machine. */
    put: (scope, key, value, u, machine = 'OTHER', d = null) =>
      rows.set(`${scope}|${key}`, { scope, key, value, u, deleted_at: d, machine, rev: ++rev }),
  };
}

function setup(server = fakeServer(), machine = 'DESK') {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cloud-')), 'cloud-sync.local.json');
  const pulled = [];
  const cloud = createCloudSync({ client: server.client, machine, stateFile, onPulled: (scope) => pulled.push(scope), now: () => 1000 });
  return { server, cloud, stateFile, pulled };
}

const lifeDoc = (units, gone = {}) => ({ units, gone });

test('no peers before the first pull: a fresh PC never publishes defaults blind', async () => {
  const { cloud } = setup();
  assert.equal(cloud.peers('life'), null);
  await cloud.syncNow();
  assert.deepEqual(cloud.peers('life'), [{ units: [], gone: {} }]);
  assert.deepEqual(cloud.peers('todos'), [{}]);
});

test('pull: other machines rows become the peer, onPulled fires per scope', async () => {
  const { server, cloud, pulled } = setup();
  server.put('life', 'e:a', { id: 'a' }, 10);
  server.put('life', 'e:b', null, 20, 'OTHER', 20);
  server.put('todos', 'local:home:5', { text: 'milk', done: false, at: 5 }, 30);
  await cloud.syncNow();
  assert.deepEqual(cloud.peers('life'), [{ units: [{ k: 'e:a', v: { id: 'a' }, u: 10 }], gone: { 'e:b': 20 } }]);
  assert.deepEqual(cloud.peers('todos'), [{ 'local:home': { items: [{ text: 'milk', done: false, at: 5, u: 30 }], gone: {} } }]);
  assert.deepEqual(pulled.sort(), ['life', 'todos']);
});

test('pull pages through more rows than one page holds', async () => {
  const { server, cloud } = setup();
  for (let i = 1; i <= PAGE + 5; i++) server.put('life', `e:r${i}`, { id: `r${i}` }, i);
  await cloud.syncNow();
  assert.equal(cloud.peers('life')[0].units.length, PAGE + 5);
});

test('push: only unpushed units, batched to the server cap, no echo after a pull', async () => {
  const { server, cloud } = setup();
  await cloud.syncNow();
  const units = Array.from({ length: BATCH + 3 }, (_, i) => ({ k: `e:x${i}`, v: { id: `x${i}` }, u: 100 + i }));
  cloud.published('life', lifeDoc(units, { 'e:dead': 50 }));
  assert.equal(cloud.status().pending, BATCH + 4);
  await cloud.syncNow();
  const lifePushes = server.calls.pushes.filter((p) => p.p_scope === 'life');
  assert.equal(lifePushes.length, 2);
  assert.ok(lifePushes.every((p) => p.p_units.length <= BATCH && p.p_machine === 'DESK'));
  const dead = server.rows.get('life|e:dead');
  assert.deepEqual([dead.value, dead.u, dead.deleted_at], [null, 50, 50]);
  assert.equal(cloud.status().pending, 0);
  // Publishing the same doc again pushes nothing.
  const before = server.calls.pushes.length;
  cloud.published('life', lifeDoc(units, { 'e:dead': 50 }));
  await cloud.syncNow();
  assert.equal(server.calls.pushes.length, before);
});

test('own rows coming back from the server do not trigger onPulled', async () => {
  const { cloud, pulled } = setup();
  await cloud.syncNow();
  pulled.length = 0;
  cloud.published('life', lifeDoc([{ k: 'income', v: { amount: 1 }, u: 5 }]));
  await cloud.syncNow(); // push
  await cloud.syncNow(); // pull sees our own row
  assert.deepEqual(pulled, []);
});

test('a failed push keeps the units pending and the error visible; the next run sends them', async () => {
  const { server, cloud } = setup();
  await cloud.syncNow();
  cloud.published('life', lifeDoc([{ k: 'income', v: { amount: 1 }, u: 5 }]));
  server.setFailPush(true);
  const res = await cloud.syncNow();
  assert.equal(res.ok, false);
  assert.equal(cloud.status().pending, 1);
  assert.equal(cloud.status().error, 'push-failed');
  server.setFailPush(false);
  assert.equal((await cloud.syncNow()).ok, true);
  assert.equal(cloud.status().pending, 0);
  assert.equal(cloud.status().error, null);
});

test('a failed pull keeps the cursor; peers stay null until a pull worked', async () => {
  const { server, cloud } = setup();
  server.setFailPull(true);
  assert.equal((await cloud.syncNow()).ok, false);
  assert.equal(cloud.peers('life'), null);
  assert.equal(cloud.status().error, 'pull-failed');
});

test('cursor, pushed and mirror survive a restart; a new instance pulls only newer rows', async () => {
  const server = fakeServer();
  const first = setup(server);
  server.put('life', 'e:a', { id: 'a' }, 10);
  await first.cloud.syncNow();
  const again = createCloudSync({ client: server.client, machine: 'DESK', stateFile: first.stateFile, onPulled: () => {}, now: () => 1000 });
  assert.equal(again.peers('life'), null); // still needs this session's first pull
  const pullsBefore = server.calls.pulls;
  await again.syncNow();
  assert.equal(again.peers('life')[0].units.length, 1);
  assert.equal(server.calls.pulls - pullsBefore, SCOPES.length); // one empty page per scope
});

test('a corrupt state file starts over instead of throwing', async () => {
  const { stateFile, server } = setup();
  fs.writeFileSync(stateFile, '{nope');
  const cloud = createCloudSync({ client: server.client, machine: 'DESK', stateFile, onPulled: () => {}, now: () => 1 });
  assert.equal((await cloud.syncNow()).ok, true);
});

test('reset forgets the state (logout)', async () => {
  const { cloud, stateFile, server } = setup();
  server.put('life', 'e:a', { id: 'a' }, 10);
  await cloud.syncNow();
  cloud.reset();
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(cloud.peers('life'), null);
});

test('concurrent syncNow calls run one after the other', async () => {
  const { cloud, server } = setup();
  server.put('life', 'e:a', { id: 'a' }, 10);
  const [a, b] = await Promise.all([cloud.syncNow(), cloud.syncNow()]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(cloud.peers('life')[0].units.length, 1);
});

test('state belongs to one user: another user starts from scratch', async () => {
  const server = fakeServer();
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cloud-')), 'cloud-sync.local.json');
  server.put('life', 'e:a', { id: 'a' }, 10);
  const asA = createCloudSync({ client: server.client, machine: 'DESK', stateFile, userId: () => 'user-a', now: () => 1000 });
  await asA.syncNow();
  server.rows.clear(); // user B's account is empty (RLS shows B nothing of A's)
  const asB = createCloudSync({ client: server.client, machine: 'DESK', stateFile, userId: () => 'user-b', now: () => 1000 });
  await asB.syncNow();
  assert.deepEqual(asB.peers('life'), [{ units: [], gone: {} }]);
});

test('a reset during a running pull drops that pull (logout race)', async () => {
  const server = fakeServer();
  server.put('life', 'e:a', { id: 'a' }, 10);
  const { cloud, stateFile } = setup(server);
  const running = cloud.syncNow();
  cloud.reset();
  await running;
  await new Promise((r) => setImmediate(r));
  assert.equal(cloud.peers('life'), null);
  assert.equal(fs.existsSync(stateFile), false);
});
