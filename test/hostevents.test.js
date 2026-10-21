// ============================================================================
// LunaCore - a host chat's event feed (src/hostevents.js)
// ----------------------------------------------------------------------------
// Batching of partial text (~300 ms, flushed before any other kind so order
// holds), clipping to 4 KB with the note, retention (sessions idle 14 days),
// and the reader the phone shares: unknown kinds and junk fields dropped.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ev = require('../src/hostevents');

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-000000000000';
const NOW = 1_800_000_000_000;

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimer: (fn, ms) => {
      pending.set(++n, { fn, ms });
      return n;
    },
    clearTimer: (id) => pending.delete(id),
    fire() {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    pending,
  };
}

/** A supabase-js-like client recording inserts and answering prune reads. */
function fakeClient({ old = [], recent = [] } = {}) {
  const inserts = [];
  const deletes = [];
  const query = (table) => {
    const q = { table, filters: [] };
    const chain = {
      insert: async (row) => {
        inserts.push(row);
        return { error: null };
      },
      select() {
        q.op = 'select';
        return chain;
      },
      delete() {
        q.op = 'delete';
        return chain;
      },
      eq(k, v) {
        q.filters.push(['eq', k, v]);
        return chain;
      },
      lt(k, v) {
        q.filters.push(['lt', k, v]);
        return chain;
      },
      gte(k, v) {
        q.filters.push(['gte', k, v]);
        return chain;
      },
      in(k, v) {
        q.filters.push(['in', k, v]);
        if (q.op === 'delete') {
          deletes.push(v);
          return Promise.resolve({ error: null });
        }
        return chain;
      },
      limit() {
        return Promise.resolve({ data: old, error: null });
      },
      then(resolve) {
        // The "recent" read ends on .gte(): awaited directly.
        resolve({ data: recent, error: null });
      },
    };
    return chain;
  };
  return { client: { from: query }, inserts, deletes };
}

test('partial text is batched into one row after the window', async () => {
  const timers = fakeTimers();
  const { client, inserts } = fakeClient();
  const w = ev.createHostEvents({ client, host: 'KT-PC', now: () => NOW, ...timers, log: () => {} });
  w.text(SID, 'Hel');
  w.text(SID, 'lo ');
  w.text(SID, 'world');
  assert.equal(inserts.length, 0);
  assert.equal([...timers.pending.values()][0].ms, ev.BATCH_MS);
  timers.fire();
  await w.idle();
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].data, { text: 'Hello world' });
  assert.equal(inserts[0].kind, 'text');
  assert.equal(inserts[0].seq, 0);
  assert.equal(inserts[0].host, 'KT-PC');
});

test('another kind flushes buffered text first, so seq follows order', async () => {
  const timers = fakeTimers();
  const { client, inserts } = fakeClient();
  const w = ev.createHostEvents({ client, host: 'KT-PC', now: () => NOW, ...timers, log: () => {} });
  w.text(SID, 'Running it');
  w.emit(SID, 'tool', { id: 't1', name: 'Bash', summary: 'npm test' });
  w.text(SID2, 'other session');
  await w.idle();
  assert.deepEqual(inserts.map((r) => [r.kind, r.seq]), [['text', 0], ['tool', 1]]);
  assert.equal(timers.pending.size, 1, 'the other session keeps its own buffer');
  timers.fire();
  await w.idle();
  assert.equal(inserts[2].session_id, SID2);
  assert.equal(inserts[2].seq, 0);
});

test('malformed events never reach the table', async () => {
  const { client, inserts } = fakeClient();
  const w = ev.createHostEvents({ client, host: 'KT-PC', now: () => NOW, log: () => {} });
  w.emit(SID, 'status', { status: 'sleeping' });
  w.emit('not-a-session', 'status', { status: 'done' });
  w.emit(SID, 'evil', {});
  await w.idle();
  assert.equal(inserts.length, 0);
});

test('clip keeps 4 KB and says where the rest is', () => {
  const short = ev.clip('small');
  assert.deepEqual(short, { text: 'small', clipped: false });
  const big = ev.clip('x'.repeat(10000));
  assert.equal(big.clipped, true);
  assert.ok(big.text.endsWith('(full output on the host)'));
  assert.ok(ev.byteLength(big.text) <= ev.CLIP_BYTES + 40);
  // Multi-byte characters are never cut in half.
  const pl = ev.clip('ż'.repeat(3000));
  assert.ok(pl.clipped);
  assert.ok(!pl.text.includes('�'));
  assert.ok(ev.byteLength(pl.text.split('\n…')[0]) <= ev.CLIP_BYTES);
});

test('sessionsToDrop keeps a session with any recent event', () => {
  const old = [{ session_id: SID }, { session_id: SID }, { session_id: SID2 }, { session_id: 'junk' }];
  const recent = [{ session_id: SID2 }];
  assert.deepEqual(ev.sessionsToDrop(old, recent), [SID]);
  assert.deepEqual(ev.sessionsToDrop([], []), []);
});

test('prune deletes only sessions idle for 14 days, on this host', async () => {
  const { client, deletes } = fakeClient({ old: [{ session_id: SID }, { session_id: SID2 }], recent: [{ session_id: SID2 }] });
  const w = ev.createHostEvents({ client, host: 'KT-PC', now: () => NOW, log: () => {} });
  const n = await w.prune();
  assert.equal(n, 1);
  assert.deepEqual(deletes, [[SID]]);
});

test('prune with nothing old touches nothing', async () => {
  const { client, deletes } = fakeClient({ old: [] });
  const w = ev.createHostEvents({ client, host: 'KT-PC', now: () => NOW, log: () => {} });
  assert.equal(await w.prune(), 0);
  assert.deepEqual(deletes, []);
});

test('parseEvent: known kinds only, fields cleaned', () => {
  const at = new Date(NOW).toISOString();
  assert.equal(ev.parseEvent({ session_id: SID, seq: 0, host: 'H', kind: 'html', data: {}, at }), null);
  assert.equal(ev.parseEvent({ session_id: SID, seq: -1, host: 'H', kind: 'text', data: { text: 'x' }, at }), null);
  assert.equal(ev.parseEvent({ session_id: SID, seq: 1, host: 'H', kind: 'status', data: { status: 'pwned' }, at }), null);
  const p = ev.parseEvent({ session_id: SID, seq: 3, host: 'H', kind: 'permission', data: { requestId: 'abc-1', tool: 'Bash\u0000', summary: 'rm -rf x', preview: '', extra: 'dropped' }, at });
  assert.deepEqual(p.data, { requestId: 'abc-1', tool: 'Bash', summary: 'rm -rf x', preview: '' });
  assert.equal(p.at, NOW);
  const t = ev.parseEvent({ session_id: SID, seq: 4, host: 'H', kind: 'text', data: { text: 'line1\nline2\u0007' }, at });
  assert.equal(t.data.text, 'line1\nline2');
});

test('eventsFrom sorts by seq and drops duplicates', () => {
  const at = new Date(NOW).toISOString();
  const rows = [
    { session_id: SID, seq: 2, host: 'H', kind: 'text', data: { text: 'c' }, at },
    { session_id: SID, seq: 0, host: 'H', kind: 'text', data: { text: 'a' }, at },
    { session_id: SID, seq: 0, host: 'H', kind: 'text', data: { text: 'dup' }, at },
    null,
  ];
  assert.deepEqual(ev.eventsFrom(rows).map((e) => e.data.text), ['a', 'c']);
});

// Review J-H2 (docs/REMOTE_HOST_PLAN.md "Security review"): a resumed session
// restarted seq at 0 and every row hit the unique (user_id, session_id, seq) index.
test('continueSession: a resumed session writes after its highest stored seq', async () => {
  const sid = '11111111-2222-4333-8444-555555555555';
  const inserts = [];
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ seq: 41 }], error: null }) }) }) }),
      insert: async (row) => {
        inserts.push(row);
        return { error: null };
      },
    }),
  };
  const w = ev.createHostEvents({ client, host: 'KT-PC', log: () => {} });
  await w.continueSession(sid);
  await w.emit(sid, 'status', { status: 'working' });
  assert.equal(inserts[0].seq, 42);
});

test('continueSession: a failed read leaves the counter and never throws', async () => {
  const sid = '11111111-2222-4333-8444-555555555555';
  const client = { from: () => ({ select: () => { throw new Error('offline'); }, insert: async () => ({ error: null }) }) };
  const w = ev.createHostEvents({ client, host: 'KT-PC', log: () => {} });
  await w.continueSession(sid);
});

test('cleanCard is what the phone reads back: cleaning twice changes nothing', () => {
  const summary = `${'a'.repeat(299)} tail`;
  const once = ev.cleanCard({ requestId: 'r1', tool: 'Bash', summary, preview: 'x\n' });
  const twice = ev.parseEvent({ session_id: '11111111-2222-4333-8444-555555555555', seq: 0, host: 'H', kind: 'permission', data: once, at: new Date().toISOString() }).data;
  assert.deepEqual(twice, once);
  assert.equal(once.summary.endsWith(' '), false);
});
