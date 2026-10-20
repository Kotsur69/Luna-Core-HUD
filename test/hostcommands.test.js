// ============================================================================
// LunaCore - the host's command loop (src/hostcommands.js)
// ----------------------------------------------------------------------------
// A fake supabase-js client over an in-memory table. Covered: the claim is
// one conditional update (two loops never run the same row), realtime only
// triggers a read, the 3 s poll takes over while the socket is down, and
// every refusal path (no verifier, bad signature, unknown kind, expiry,
// malformed row) ends as `refused` without running anything.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostCommands, cleanRow, MAX_TTL_MS } = require('../src/hostcommands.js');

const NOW = 1_800_000_000_000;
const HOST = 'MAC-1';

function row(over = {}) {
  return {
    id: `c${Math.random().toString(36).slice(2, 10)}`,
    host: HOST,
    kind: 'git.fetchAll',
    payload: {},
    nonce: 'nonce-123456',
    expires_at: new Date(NOW + 60000).toISOString(),
    sig: 'sig',
    status: 'new',
    result: null,
    created_at: new Date(NOW).toISOString(),
    ...over,
  };
}

/** Just enough of supabase-js: from().select/update().eq().order().limit(), channels. */
function fakeClient(initial = []) {
  const table = initial.map((r) => ({ ...r }));
  const channel = { statusCb: null, eventCb: null };
  function query() {
    const q = { op: 'select', patch: null, returning: false, filters: [], max: Infinity };
    const run = () => {
      const hits = table.filter((r) => q.filters.every(([c, v]) => r[c] === v));
      if (q.op === 'update') {
        hits.forEach((r) => Object.assign(r, q.patch));
        return { data: q.returning ? hits.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: hits.slice(0, q.max).map((r) => ({ ...r, payload: r.payload && typeof r.payload === 'object' ? { ...r.payload } : r.payload })), error: null };
    };
    const api = {
      select() {
        if (q.op === 'update') q.returning = true;
        return api;
      },
      update(patch) {
        q.op = 'update';
        q.patch = patch;
        return api;
      },
      eq(c, v) {
        q.filters.push([c, v]);
        return api;
      },
      order: () => api,
      limit(n) {
        q.max = n;
        return api;
      },
      // Runs when awaited, in one step: like a single SQL statement.
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return api;
  }
  return {
    table,
    channel,
    from: () => query(),
    channel: () => {
      const ch = {
        on(_type, _filter, cb) {
          channel.eventCb = cb;
          return ch;
        },
        subscribe(cb) {
          channel.statusCb = cb;
          return ch;
        },
      };
      return ch;
    },
    removeChannel() {},
    _channel: channel,
  };
}

/** Manual timers: tests fire them. */
function timers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimer: (fn) => {
      pending.set(++n, fn);
      return n;
    },
    clearTimer: (id) => pending.delete(id),
    async fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) await fn();
    },
    count: () => pending.size,
  };
}

const okVerify = async () => ({ ok: true });

function setup({ rows = [], verify = okVerify, handlers, client } = {}) {
  const c = client || fakeClient(rows);
  const logs = [];
  const t = timers();
  const ran = [];
  const loop = createHostCommands({
    client: c,
    host: HOST,
    verify,
    handlers: handlers || {
      'git.fetchAll': async (payload, r) => {
        ran.push(r.id);
        return { fetched: 2 };
      },
    },
    now: () => NOW,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    log: (line) => logs.push(line),
  });
  return { client: c, loop, logs, t, ran };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a verified known command is claimed, run, and marked done with its result', async () => {
  const r = row();
  const { client, loop, ran } = setup({ rows: [r] });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, [r.id]);
  assert.equal(client.table[0].status, 'done');
  assert.deepEqual(client.table[0].result, { fetched: 2 });
  loop.stop();
});

test('atomic claim: two loops on the same rows never run one twice', async () => {
  const rows = [row(), row(), row()];
  const client = fakeClient(rows);
  const a = setup({ client });
  const b = setup({ client });
  a.loop.start();
  b.loop.start();
  await Promise.all([a.loop.read(), b.loop.read()]);
  await settle();
  const all = [...a.ran, ...b.ran].sort();
  assert.deepEqual(all, rows.map((r) => r.id).sort(), 'each row ran exactly once');
  assert.ok(client.table.every((r) => r.status === 'done'));
  a.loop.stop();
  b.loop.stop();
});

test('a row already claimed elsewhere is left alone', async () => {
  const r = row({ status: 'claimed' });
  const { client, loop, ran } = setup({ rows: [r] });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, []);
  assert.equal(client.table[0].status, 'claimed');
  loop.stop();
});

test('another host\'s rows are never read', async () => {
  const { client, loop, ran } = setup({ rows: [row({ host: 'OTHER' })] });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, []);
  assert.equal(client.table[0].status, 'new');
  loop.stop();
});

test('realtime only triggers a read; the poll takes over while it is down', async () => {
  const { client, loop, ran, t } = setup();
  loop.start();
  await settle();
  client._channel.statusCb('SUBSCRIBED');
  assert.equal(loop.isPolling(), false);
  // An event: a debounced read, which finds the new row in the table.
  const r1 = row();
  client.table.push(r1);
  client._channel.eventCb({ new: { id: 'forged', kind: 'evil.kind' } });
  await t.fireAll();
  await settle();
  assert.deepEqual(ran, [r1.id], 'the event payload itself is never acted on');

  client._channel.statusCb('CHANNEL_ERROR');
  assert.equal(loop.isPolling(), true);
  const r2 = row();
  client.table.push(r2);
  await t.fireAll(); // one 3 s poll tick
  await settle();
  assert.deepEqual(ran, [r1.id, r2.id]);
  assert.ok(t.count() >= 1, 'the next poll is scheduled');

  client._channel.statusCb('SUBSCRIBED');
  assert.equal(loop.isPolling(), false);
  loop.stop();
});

test('refused: no verifier injected -> nothing runs', async () => {
  const { client, loop, ran, logs } = setup({ rows: [row()], verify: null });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, []);
  assert.equal(client.table[0].status, 'refused');
  assert.deepEqual(client.table[0].result, { error: 'no-verifier' });
  assert.ok(logs.some((l) => l.includes('no-verifier')));
  loop.stop();
});

test('refused: the verifier says no, or throws', async () => {
  const a = setup({ rows: [row()], verify: async () => ({ ok: false, reason: 'bad-signature' }) });
  a.loop.start();
  await a.loop.read();
  assert.equal(a.client.table[0].status, 'refused');
  assert.deepEqual(a.client.table[0].result, { error: 'bad-signature' });
  assert.deepEqual(a.ran, []);

  const b = setup({ rows: [row()], verify: async () => { throw new Error('boom'); } });
  b.loop.start();
  await b.loop.read();
  assert.equal(b.client.table[0].status, 'refused');
  assert.deepEqual(b.ran, []);
  a.loop.stop();
  b.loop.stop();
});

test('refused and logged: an unknown kind', async () => {
  const { client, loop, logs } = setup({ rows: [row({ kind: 'shell.exec' })] });
  loop.start();
  await loop.read();
  assert.equal(client.table[0].status, 'refused');
  assert.deepEqual(client.table[0].result, { error: 'unknown-kind' });
  assert.ok(logs.some((l) => l.includes('shell.exec') && l.includes('unknown-kind')));
  loop.stop();
});

test('refused: prototype keys are no handlers', async () => {
  const { client, loop } = setup({ rows: [row({ kind: 'constructor.x' }), row({ kind: 'to.String' })] });
  loop.start();
  await loop.read();
  assert.ok(client.table.every((r) => r.status === 'refused'));
  loop.stop();
});

test('refused: expired, or an expiry further out than allowed', async () => {
  const { client, loop, ran } = setup({
    rows: [
      row({ expires_at: new Date(NOW - 1).toISOString() }),
      row({ expires_at: new Date(NOW + MAX_TTL_MS + 1000).toISOString() }),
    ],
  });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, []);
  assert.deepEqual(client.table.map((r) => r.result.error), ['expired', 'expiry-too-far']);
  loop.stop();
});

test('refused: a malformed row is claimed and refused, never run', async () => {
  const { client, loop, ran } = setup({ rows: [row({ payload: 'not-an-object' }), row({ kind: 'bad kind!' })] });
  loop.start();
  await loop.read();
  assert.deepEqual(ran, []);
  assert.ok(client.table.every((r) => r.status === 'refused' && r.result.error === 'malformed'));
  loop.stop();
});

test('a handler that throws ends as failed with the message', async () => {
  const { client, loop } = setup({
    rows: [row()],
    handlers: {
      'git.fetchAll': async () => {
        throw new Error('network down');
      },
    },
  });
  loop.start();
  await loop.read();
  assert.equal(client.table[0].status, 'failed');
  assert.deepEqual(client.table[0].result, { error: 'network down' });
  loop.stop();
});

test('the handler gets a copy: it cannot change what the verifier saw', async () => {
  let seen = null;
  const { loop } = setup({
    rows: [row({ payload: { a: 1 } })],
    verify: async (r) => {
      seen = r.payload;
      return { ok: true };
    },
    handlers: {
      'git.fetchAll': async (payload) => {
        payload.a = 2;
        return {};
      },
    },
  });
  loop.start();
  await loop.read();
  assert.deepEqual(seen, { a: 1 });
  loop.stop();
});

test('cleanRow: shape checks', () => {
  assert.ok(cleanRow(row()));
  assert.equal(cleanRow(row({ expires_at: 'never' })), null);
  assert.equal(cleanRow(row({ nonce: 5 })), null);
  assert.equal(cleanRow(row({ id: '' })), null);
  assert.equal(cleanRow(null), null);
});
