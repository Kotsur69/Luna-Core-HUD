// ============================================================================
// LunaCore - Google Calendar API client tests (src/gcal.js)
// ----------------------------------------------------------------------------
// No network, no browser, no keychain: fetch, openExternal and safeStorage are
// injected, and the client/token files live in a temp dir. The one real
// socket is the loopback redirect server, bound to 127.0.0.1 on a free port.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gcal = require('../src/gcal.js');

const CATS = [{ id: 'work', label: 'Work', colorId: '9', color: '#5484ed' }];

/** "Encrypts" by prefixing - enough to prove the round trip goes through it. */
const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
};

function tempFiles({ refreshToken } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-test-'));
  const clientPath = path.join(dir, 'client.json');
  const tokenPath = path.join(dir, 'token.json');
  fs.writeFileSync(
    clientPath,
    JSON.stringify({ installed: { client_id: 'c.apps.googleusercontent.com', client_secret: 'sec' } })
  );
  if (refreshToken) {
    fs.writeFileSync(tokenPath, JSON.stringify({ v: 1, enc: Buffer.from(`enc:${refreshToken}`).toString('base64') }));
  }
  return { clientPath, tokenPath };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("parseClientFile accepts Google's Desktop client JSON and rejects junk", () => {
  const ok = { installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' } };
  assert.deepEqual(gcal.parseClientFile(ok), {
    clientId: '123-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-x',
  });
  assert.equal(gcal.parseClientFile({ installed: { client_id: 'evil.example.com', client_secret: 'x' } }), null);
  assert.equal(gcal.parseClientFile({ installed: { client_id: '1.apps.googleusercontent.com' } }), null);
  assert.equal(gcal.parseClientFile(null), null);
});

test('auth URL asks for read-only scope, offline access and a PKCE S256 challenge', () => {
  const url = new URL(
    gcal.buildAuthUrl({
      clientId: 'c.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:5555',
      state: 's',
      challenge: 'ch',
    })
  );
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
});

test('normalizeEvent: all-day vs timed, category from colorId, calendar name and colour', () => {
  const cal = { name: 'Praca', color: '#5484ed' };
  const timed = gcal.normalizeEvent(
    {
      id: 'a1',
      summary: 'Standup',
      colorId: '9',
      start: { dateTime: '2026-10-08T09:30:00+02:00' },
      end: { dateTime: '2026-10-08T10:00:00+02:00' },
    },
    cal,
    CATS
  );
  assert.deepEqual([timed.allDay, timed.category, timed.calendar, timed.color], [false, 'work', 'Praca', '#5484ed']);
  const allDay = gcal.normalizeEvent({ id: 'b', start: { date: '2026-10-10' }, end: { date: '2026-10-12' } }, cal, CATS);
  assert.deepEqual([allDay.allDay, allDay.start, allDay.end, allDay.title], [true, '2026-10-10', '2026-10-12', '(no title)']);
});

test('normalizeEvent drops cancelled, declined and unparseable events', () => {
  const cal = { name: 'x', color: null };
  assert.equal(gcal.normalizeEvent({ status: 'cancelled', start: { date: '2026-10-10' } }, cal, CATS), null);
  const declined = { start: { date: '2026-10-10' }, attendees: [{ self: true, responseStatus: 'declined' }] };
  assert.equal(gcal.normalizeEvent(declined, cal, CATS), null);
  assert.equal(gcal.normalizeEvent({ start: { dateTime: 'soon' } }, cal, CATS), null);
});

test('visibleCalendars keeps the ticked ones and validates the colour', () => {
  const cals = gcal.visibleCalendars([
    { id: 'me@gmail.com', primary: true, summary: 'me' },
    { id: 'work@group', selected: true, summary: 'Praca', backgroundColor: '#123456' },
    { id: 'hidden@group', summary: 'Hidden' },
    { id: 'x@group', selected: true, summary: 'X', backgroundColor: 'red;}' },
  ]);
  assert.deepEqual(cals.map((c) => c.name), ['me', 'Praca', 'X']);
  assert.equal(cals[1].color, '#123456');
  assert.equal(cals[2].color, null);
});

test('mergeEvents keeps one copy of an invite seen in two calendars, sorted', () => {
  const ev = (uid, start, calendar) => ({ uid, start, end: start, allDay: false, calendar });
  const merged = gcal.mergeEvents([
    [ev('u1', '2026-10-09T10:00:00Z', 'me'), ev('u2', '2026-10-08T10:00:00Z', 'me')],
    [ev('u1', '2026-10-09T10:00:00Z', 'Praca')],
  ]);
  assert.deepEqual(merged.map((e) => e.start), ['2026-10-08T10:00:00Z', '2026-10-09T10:00:00Z']);
  assert.equal('uid' in merged[0], false);
});

test('listEvents refreshes the access token and reads every visible calendar', async () => {
  const files = tempFiles({ refreshToken: 'refresh-1' });
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    seen.push({ url: u, opts });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      assert.match(opts.body, /refresh_token=refresh-1/);
      return json({ access_token: 'acc', expires_in: 3600 });
    }
    if (u.includes('/users/me/calendarList')) {
      return json({
        items: [
          { id: 'me@gmail.com', primary: true, summary: 'me' },
          { id: 'work@group', selected: true, summary: 'Praca' },
        ],
      });
    }
    const id = decodeURIComponent(u.split('/calendars/')[1].split('/events')[0]);
    return json({ items: [{ id: `${id[0]}1`, iCalUID: id, start: { date: '2026-10-10' }, end: { date: '2026-10-11' } }] });
  };
  const client = gcal.createGcal({ fetchImpl, safeStorage: fakeStorage, ...files });
  assert.deepEqual(client.status(), { configured: true, connected: true });
  const { events } = await client.listEvents({
    fromIso: '2026-10-01T00:00:00+02:00',
    toIso: '2026-11-01T00:00:00+01:00',
    categories: CATS,
  });
  assert.deepEqual(events.map((e) => e.calendar).sort(), ['Praca', 'me']);
  const eventCall = seen.find((c) => c.url.includes('/events?'));
  assert.equal(eventCall.opts.headers.Authorization, 'Bearer acc');
  assert.match(eventCall.url, /singleEvents=true/);
  // One token refresh serves every calendar request.
  assert.equal(seen.filter((c) => c.url.startsWith('https://oauth2')).length, 1);
});

test('a revoked refresh token is forgotten and reported as gcal-auth', async () => {
  const files = tempFiles({ refreshToken: 'dead' });
  const fetchImpl = async () => json({ error: 'invalid_grant' }, 400);
  const client = gcal.createGcal({ fetchImpl, safeStorage: fakeStorage, ...files });
  await assert.rejects(client.listEvents({ fromIso: 'a', toIso: 'b', categories: [] }), { reason: 'gcal-auth' });
  assert.equal(fs.existsSync(files.tokenPath), false);
  assert.equal(client.status().connected, false);
});

test('no client file -> gcal-no-client, before any network call', async () => {
  let fetched = false;
  const missing = path.join(os.tmpdir(), `no-such-gcal-${process.pid}`);
  const client = gcal.createGcal({
    fetchImpl: async () => {
      fetched = true;
    },
    safeStorage: fakeStorage,
    clientPath: `${missing}-client.json`,
    tokenPath: `${missing}-token.json`,
  });
  await assert.rejects(client.connect(), { reason: 'gcal-no-client' });
  await assert.rejects(client.listEvents({ fromIso: 'a', toIso: 'b', categories: [] }), { reason: 'gcal-no-client' });
  assert.equal(fetched, false);
});

test('connect: PKCE code exchange via the loopback redirect, token stored encrypted', async () => {
  const files = tempFiles();
  let tokenBody = '';
  const fetchImpl = async (url, opts) => {
    tokenBody = opts.body;
    return json({ refresh_token: 'r-new', access_token: 'a', expires_in: 3600 });
  };
  const openExternal = async (authUrl) => {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get('redirect_uri');
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);
    // A request with the wrong state is not the redirect.
    assert.equal((await fetch(`${redirect}/?code=evil&state=wrong`)).status, 404);
    const ok = await fetch(`${redirect}/?code=good-code&state=${u.searchParams.get('state')}`);
    assert.equal(ok.status, 200);
  };
  const client = gcal.createGcal({ fetchImpl, openExternal, safeStorage: fakeStorage, ...files });
  await client.connect();
  assert.match(tokenBody, /code=good-code/);
  assert.match(tokenBody, /code_verifier=[A-Za-z0-9_-]{43,}/);
  assert.doesNotMatch(tokenBody, /evil/);
  const stored = JSON.parse(fs.readFileSync(files.tokenPath, 'utf8'));
  assert.equal(Buffer.from(stored.enc, 'base64').toString(), 'enc:r-new');
  assert.equal(client.status().connected, true);
});

test('connect: the user declining consent rejects with gcal-denied', async () => {
  const files = tempFiles();
  const openExternal = async (authUrl) => {
    const u = new URL(authUrl);
    await fetch(`${u.searchParams.get('redirect_uri')}/?error=access_denied&state=${u.searchParams.get('state')}`);
  };
  const client = gcal.createGcal({ fetchImpl: async () => json({}), openExternal, safeStorage: fakeStorage, ...files });
  await assert.rejects(client.connect(), { reason: 'gcal-denied' });
  assert.equal(client.status().connected, false);
});
