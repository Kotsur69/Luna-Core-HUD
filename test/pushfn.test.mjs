// Supabase Edge Function `push` (supabase/functions/push/core.mjs): generic
// bodies only, each key fires once, 404/410 subscriptions dropped, only the
// owner's session (or the schedule's secret) gets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notification, parsePushRequest, offlineKey, sameSecret, fanOut, handle, OFFLINE_MS } from '../supabase/functions/push/core.mjs';

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
const NOW = 1_800_000_000_000;
const ENV = { SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_ANON_KEY: 'anon', OWNER_USER_ID: OWNER, CRON_SECRET: 'cron-secret-123', PUSH_LANG: 'en' };

function fakeDb({ seen = null, subs = [{ id: 's1', endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' }] } = {}) {
  const claimed = new Set();
  const dropped = [];
  return {
    claimed,
    dropped,
    subscriptions: async () => subs,
    dropSubscription: async (id) => dropped.push(id),
    claimOnce: async (uid, key) => {
      const k = `${uid}|${key}`;
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    defaultHostSeen: async () => seen,
  };
}

const userFetch = (id) => async () => ({ ok: true, json: async () => ({ id }) });
const req = (body, headers = {}) =>
  new Request('https://ref.supabase.co/functions/v1/push', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });

test('bodies are generic: built from the event, never from caller text', () => {
  assert.equal(notification({ event: 'approval', machine: 'KT-PC-LLM' }, 'en').body, 'Approval needed on KT-PC-LLM');
  assert.equal(notification({ event: 'approval', machine: 'KT-PC-LLM' }, 'pl').body, 'Potrzebna zgoda na KT-PC-LLM');
  assert.equal(notification({ event: 'usage', window: 'fiveHour', level: 95 }, 'en').body, 'Claude 5 h limit at 95%');
  const p = parsePushRequest({ event: 'approval', machine: 'KT-PC', key: 'approval:abc', body: 'rm -rf /', text: 'secret code' });
  assert.deepEqual(p, { ok: true, event: 'approval', machine: 'KT-PC', key: 'approval:abc' });
});

test('requests are validated', () => {
  assert.equal(parsePushRequest({ event: 'approval', machine: 'bad name', key: 'k' }).ok, false);
  assert.equal(parsePushRequest({ event: 'approval', machine: 'KT', key: 'has space' }).ok, false);
  assert.equal(parsePushRequest({ event: 'usage', machine: 'KT', key: 'k', window: 'fiveHour', level: 50 }).ok, false);
  assert.equal(parsePushRequest({ event: 'html', machine: 'KT', key: 'k' }).ok, false);
  assert.equal(parsePushRequest(null).ok, false);
  assert.equal(parsePushRequest({ event: 'offline-check' }).ok, true);
});

test('offlineKey fires per outage, only past the threshold', () => {
  assert.equal(offlineKey({ machine: 'KT', updatedAt: NOW - 1000 }, NOW), null);
  assert.equal(offlineKey({ machine: 'KT', updatedAt: NOW - OFFLINE_MS - 1 }, NOW), `offline:KT:${NOW - OFFLINE_MS - 1}`);
  assert.equal(offlineKey(null, NOW), null);
  assert.equal(offlineKey({ machine: 'KT', updatedAt: null }, NOW), null);
});

test('sameSecret', () => {
  assert.ok(sameSecret('abc', 'abc'));
  assert.ok(!sameSecret('abc', 'abd'));
  assert.ok(!sameSecret('', ''));
});

test('fanOut drops 404/410 subscriptions and keeps others', async () => {
  const db = fakeDb({ subs: [{ id: 'gone', endpoint: 'x' }, { id: 'ok', endpoint: 'y' }, { id: 'flaky', endpoint: 'z' }] });
  const sendPush = async (sub) => {
    if (sub.endpoint === 'x') throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (sub.endpoint === 'z') throw Object.assign(new Error('busy'), { statusCode: 500 });
  };
  const r = await fanOut({ db, sendPush, userId: OWNER, payload: {}, log: () => {} });
  assert.deepEqual(r, { sent: 1, dropped: 1 });
  assert.deepEqual(db.dropped, ['gone']);
});

test('the owner can send; each key fires once', async () => {
  const db = fakeDb();
  const sent = [];
  const deps = { env: ENV, fetchImpl: userFetch(OWNER), db: () => db, sendPush: async (s, p) => sent.push(JSON.parse(p)) };
  const r1 = await handle(req({ event: 'done', machine: 'KT-PC', key: 'done:s1:0' }), deps);
  assert.equal(r1.status, 200);
  assert.deepEqual(sent[0], { title: 'LunaCore', body: 'Session finished on KT-PC', tag: 'done-KT-PC', url: '/#host' });
  const r2 = await handle(req({ event: 'done', machine: 'KT-PC', key: 'done:s1:0' }), deps);
  assert.deepEqual(await r2.json(), { sent: 0, duplicate: true });
  assert.equal(sent.length, 1);
});

test('another user, no session or no config is refused', async () => {
  const db = fakeDb();
  const sendPush = async () => {};
  assert.equal((await handle(req({ event: 'done', machine: 'KT', key: 'k' }), { env: ENV, fetchImpl: userFetch(OTHER), db: () => db, sendPush })).status, 403);
  assert.equal((await handle(req({ event: 'done', machine: 'KT', key: 'k' }), { env: ENV, fetchImpl: async () => ({ ok: false }), db: () => db, sendPush })).status, 401);
  assert.equal((await handle(req({ event: 'done', machine: 'KT', key: 'k' }), { env: ENV, db: () => null, sendPush })).status, 503);
  assert.equal((await handle(new Request('https://x/', { method: 'GET' }), { env: ENV, db: () => db, sendPush })).status, 400);
});

test('offline-check needs the cron secret and fires once per outage', async () => {
  const db = fakeDb({ seen: { machine: 'KT-NO', updatedAt: NOW - OFFLINE_MS - 5000 } });
  const sent = [];
  const deps = { env: ENV, db: () => db, sendPush: async (s, p) => sent.push(JSON.parse(p)), now: () => NOW };
  assert.equal((await handle(req({ event: 'offline-check' }, { 'x-cron-secret': 'wrong' }), deps)).status, 401);
  assert.equal((await handle(req({ event: 'offline-check' }, { 'x-cron-secret': 'cron-secret-123' }), deps)).status, 200);
  assert.equal(sent[0].body, 'Host KT-NO is offline');
  await handle(req({ event: 'offline-check' }, { 'x-cron-secret': 'cron-secret-123' }), deps);
  assert.equal(sent.length, 1);
});
