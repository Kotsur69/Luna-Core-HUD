// Supabase Edge Function `google` (supabase/functions/google/core.mjs): only
// the owner's session gets through, requests are validated, and every value
// from Google is rebuilt and capped before it reaches the phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  parseRequest,
  normalizeDraft,
  normalizeEvent,
  mergeEvents,
  visibleCalendars,
  senderName,
  mailItem,
  parseOrigins,
  createLimiter,
  logPath,
  createGoogle,
  googleFromEnv,
  handle,
} from '../supabase/functions/google/core.mjs';

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const ORIGIN = 'https://luna.vercel.app';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
const ENV = {
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  OWNER_USER_ID: OWNER,
  ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:4173`,
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch that answers the Auth server with `uid` (null -> 401). */
const authFetch = (uid) => async (url) => (String(url).endsWith('/auth/v1/user') ? (uid ? json(200, { id: uid }) : json(401, {})) : json(500, {}));

const request = (body, { origin = ORIGIN, auth = `Bearer ${TOKEN}`, method = 'POST' } = {}) =>
  new Request('https://ref.supabase.co/functions/v1/google', {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

const fakeGoogle = () => ({
  events: async (from, to) => ({ events: [], from, to }),
  create: async (draft) => ({ event: draft }),
  mail: async () => ({ unread: 3, latest: [] }),
});

test('clamp turns control characters into spaces, trims and caps', () => {
  assert.equal(clamp(`a${String.fromCharCode(10)}b${String.fromCharCode(0)}`, 10), 'a b');
  assert.equal(clamp('  abcdef  ', 3), 'abc');
  assert.equal(clamp(42, 3), '');
});

test('parseRequest accepts the three actions and refuses anything else', () => {
  assert.deepEqual(parseRequest({ action: 'mail' }), { ok: true, action: 'mail' });
  const ev = parseRequest({ action: 'events', from: '2026-10-19T00:00:00+02:00', to: '2026-10-26T00:00:00+02:00' });
  assert.equal(ev.ok, true);
  assert.equal(parseRequest({ action: 'events', from: '2026-10-19T00:00:00', to: '2026-10-26T00:00:00Z' }).ok, false, 'no zone');
  assert.equal(parseRequest({ action: 'events', from: '2026-10-26T00:00:00Z', to: '2026-10-19T00:00:00Z' }).ok, false, 'backwards');
  assert.equal(parseRequest({ action: 'events', from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }).ok, false, 'too long');
  assert.equal(parseRequest({ action: 'delete' }).ok, false);
  assert.equal(parseRequest(null).ok, false);
});

test('normalizeDraft keeps a timed or all-day event and refuses a bad one', () => {
  assert.deepEqual(normalizeDraft({ title: ' Dentist ', start: '2026-10-20T09:00:00+02:00', end: '2026-10-20T10:00:00+02:00', location: 'Katowice' }), {
    title: 'Dentist',
    start: '2026-10-20T09:00:00+02:00',
    end: '2026-10-20T10:00:00+02:00',
    allDay: false,
    location: 'Katowice',
  });
  assert.equal(normalizeDraft({ title: 'Trip', allDay: true, start: '2026-10-20', end: '2026-10-22' }).allDay, true);
  assert.equal(normalizeDraft({ title: '', start: '2026-10-20', end: '2026-10-21', allDay: true }), null);
  assert.equal(normalizeDraft({ title: 'x', start: '2026-10-20T10:00Z', end: '2026-10-20T09:00Z' }), null);
  assert.equal(normalizeDraft({ title: 'x', allDay: true, start: '2026-10-20T10:00Z', end: '2026-10-21' }), null);
});

test('visibleCalendars keeps ticked calendars and hides email-address names', () => {
  const cals = visibleCalendars([
    { id: 'me@x.pl', summary: 'me@x.pl', primary: true, backgroundColor: '#123456' },
    { id: 'work', summary: 'Praca', selected: true, backgroundColor: 'red' },
    { id: 'hidden', summary: 'Hidden', selected: false },
    null,
  ]);
  assert.deepEqual(cals, [
    { id: 'me@x.pl', name: '', color: '#123456' },
    { id: 'work', name: 'Praca', color: null },
  ]);
});

test('normalizeEvent drops cancelled and declined events and rebuilds the rest', () => {
  const cal = { name: 'Praca', color: '#00ff00' };
  assert.equal(normalizeEvent({ status: 'cancelled', start: { date: '2026-10-20' } }, cal), null);
  assert.equal(normalizeEvent({ attendees: [{ self: true, responseStatus: 'declined' }], start: { date: '2026-10-20' } }, cal), null);
  assert.equal(normalizeEvent({ start: { dateTime: 'soon' } }, cal), null);
  const ev = normalizeEvent({ id: 'abc', iCalUID: 'u1', summary: 'Standup', start: { dateTime: '2026-10-20T09:00:00+02:00' }, end: {}, extra: 'x' }, cal);
  assert.deepEqual(ev, { id: 'abc', uid: 'u1', title: 'Standup', start: '2026-10-20T09:00:00+02:00', end: '2026-10-20T09:00:00+02:00', allDay: false, location: '', calendar: 'Praca', color: '#00ff00' });
  assert.equal(normalizeEvent({ id: 'bad id!', start: { date: '2026-10-20' } }, cal).id, '');
  assert.equal(normalizeEvent({ start: { date: '2026-10-20' } }, cal).title, '(no title)');
});

test('mergeEvents removes the second copy of an invite and sorts all-day first', () => {
  const a = { id: '1', uid: 'u', title: 'A', start: '2026-10-20T09:00:00+02:00', allDay: false };
  const b = { id: '2', uid: 'u', title: 'A', start: '2026-10-20T09:00:00+02:00', allDay: false };
  const c = { id: '3', uid: '', title: 'C', start: '2026-10-20', allDay: true };
  const out = mergeEvents([[a], [b, c]]);
  assert.deepEqual(out.map((e) => e.id), ['3', '1']);
  assert.equal('uid' in out[0], false);
});

test('senderName and mailItem keep only a name, a subject and a time', () => {
  assert.equal(senderName('"Jan Kowalski" <jan@x.pl>'), 'Jan Kowalski');
  assert.equal(senderName('<jan@x.pl>'), 'jan@x.pl');
  assert.equal(senderName('jan@x.pl'), 'jan@x.pl');
  const item = mailItem({ internalDate: '1760000000000', payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'Ola <o@x.pl>' }] } });
  assert.deepEqual(item, { from: 'Ola', subject: 'Hi', at: 1760000000000 });
  assert.deepEqual(mailItem({ payload: {} }), { from: '', subject: '(no subject)', at: null });
  assert.equal(mailItem(null), null);
});

test('parseOrigins drops junk and allows no browser when unset', () => {
  assert.deepEqual([...parseOrigins('https://A.vercel.app/, javascript:alert(1), *')], ['https://a.vercel.app']);
  assert.deepEqual([...parseOrigins(undefined)], []);
});

test('clamp hides bidi overrides and zero-width marks and never splits an emoji', () => {
  const rlo = String.fromCharCode(0x202e);
  const zw = String.fromCharCode(0x200b);
  assert.equal(clamp(`a${rlo}b${zw}c`, 10), 'a b c');
  assert.equal(clamp(`ab${String.fromCodePoint(0x1f600)}`, 3), 'ab');
});

test('createLimiter allows max calls per window, then frees up', () => {
  let t = 0;
  const allow = createLimiter(2, 1000, () => t);
  assert.deepEqual([allow(), allow(), allow()], [true, true, false]);
  t = 1000;
  assert.equal(allow(), true);
});

test('parseRequest keeps new events within a month back and about a year ahead', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const draft = (start, end) => ({ action: 'create', draft: { title: 'x', start, end } });
  assert.equal(parseRequest(draft('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z'), now).ok, true);
  assert.equal(parseRequest(draft('9999-01-01T09:00:00Z', '9999-01-01T10:00:00Z'), now).ok, false);
  assert.equal(parseRequest(draft('2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z'), now).ok, false);
});

test('logPath drops the query and masks calendar ids', () => {
  assert.equal(logPath('https://www.googleapis.com/calendar/v3/calendars/me%40x.pl/events?timeMin=1'), 'https://www.googleapis.com/calendar/v3/calendars/*/events');
});

test('createGoogle refreshes once, reuses the access token and reads the mail summary', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.match(init.body, /grant_type=refresh_token/);
      return json(200, { access_token: 'at', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer at');
    if (url.endsWith('/labels/INBOX')) return json(200, { messagesUnread: 7 });
    if (url.includes('/messages?')) return json(200, { messages: [{ id: 'm1' }, { id: '../x' }] });
    if (url.includes('/messages/m1?')) return json(200, { internalDate: '5', payload: { headers: [{ name: 'Subject', value: 'S' }] } });
    return json(404, {});
  };
  const g = createGoogle({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl, now: () => 1000 });
  assert.deepEqual(await g.mail(), { unread: 7, latest: [{ from: '', subject: 'S', at: 5 }] });
  await g.mail();
  assert.equal(calls.filter((u) => u.includes('oauth2')).length, 1);
  assert.equal(calls.some((u) => u.includes('../x')), false, 'a bad message id is never fetched');
  assert.equal(calls.some((u) => u.includes('q=')), false, 'gmail.metadata refuses q');
});

test('createGoogle lists events across visible calendars and maps a dead token', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2')) return json(200, { access_token: 'at' });
    if (url.includes('/calendarList')) return json(200, { items: [{ id: 'a@x', primary: true }, { id: 'b', selected: true, summary: 'B' }] });
    if (url.includes('/calendars/a%40x/events')) return json(200, { items: [{ id: '1', iCalUID: 'u', start: { date: '2026-10-20' } }] });
    if (url.includes('/calendars/b/events')) return json(200, { items: [{ id: '2', iCalUID: 'u', start: { date: '2026-10-20' } }] });
    return json(404, {});
  };
  let calls = 0;
  const counting = (url, init) => (calls++, fetchImpl(url, init));
  const g = createGoogle({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: counting });
  const { events } = await g.events('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z');
  assert.deepEqual(events.map((e) => e.id), ['1']);
  const before = calls;
  await g.events('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z');
  assert.equal(calls, before, 'the same week within 30 s comes from memory');

  const dead = createGoogle({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: async () => json(400, { error: 'invalid_grant' }) });
  await assert.rejects(dead.mail(), (err) => err.reason === 'google-auth');
});

test('googleFromEnv is null until all three Google secrets are set', () => {
  assert.equal(googleFromEnv({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' }), null);
  assert.equal(typeof googleFromEnv({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' }).mail, 'function');
});

test('handle answers the owner and sets CORS for a listed origin', async () => {
  const res = await handle(request({ action: 'mail' }), { env: ENV, fetchImpl: authFetch(OWNER), google: fakeGoogle });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await res.json(), { unread: 3, latest: [] });
});

test('handle refuses strangers, other users, unlisted origins and bad bodies', async () => {
  const run = (req, uid = OWNER, env = ENV, google = fakeGoogle) => handle(req, { env, fetchImpl: authFetch(uid), google });
  assert.equal((await run(request({ action: 'mail' }, { auth: null }))).status, 401);
  assert.equal((await run(request({ action: 'mail' }), null)).status, 401);
  assert.equal((await run(request({ action: 'mail' }), OTHER)).status, 403);
  const evil = await run(request({ action: 'mail' }, { origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await run(request('not json'))).status, 400);
  assert.equal((await run(request('x'.repeat(5000)))).status, 400);
  assert.equal((await run(request({ action: 'drop-all' }))).status, 400);
  assert.equal((await run(request(null, { method: 'GET' }))).status, 400);
  assert.equal((await run(request({ action: 'mail' }), OWNER, { ...ENV, OWNER_USER_ID: '' })).status, 503);
  assert.equal((await run(request({ action: 'mail' }), OWNER, ENV, () => null)).status, 503);
});

test('handle answers 429 once an action is over its limit', async () => {
  const limits = { mail: createLimiter(1, 60000) };
  const run = () => handle(request({ action: 'mail' }), { env: ENV, fetchImpl: authFetch(OWNER), google: fakeGoogle, limits });
  assert.equal((await run()).status, 200);
  const res = await run();
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate-limited' });
});

test('handle answers a preflight and reports a Google failure by reason only', async () => {
  const pre = await handle(request(null, { method: 'OPTIONS' }), { env: ENV, google: fakeGoogle });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);

  const logs = [];
  const failing = () => ({ mail: async () => Promise.reject(new Error('boom secret detail')) });
  const res = await handle(request({ action: 'mail' }), { env: ENV, fetchImpl: authFetch(OWNER), google: failing, log: (m) => logs.push(m) });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'google-failed' });
  assert.match(logs[0], /boom/);
});
