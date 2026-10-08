// ============================================================================
// LunaCore - Google Calendar API client (read-only, OAuth 2.0)
// ----------------------------------------------------------------------------
// Mission Control's agenda and month grid read the calendar through this
// module, straight from the Calendar API v3: no model call, no cost, and every
// calendar the user has ticked in Google Calendar (not only the primary one).
//
// Auth is the installed-app flow Google documents for desktop apps:
//   - the user's own OAuth client (a "Desktop app" client from their Google
//     Cloud project), dropped at <user config>/google-oauth.local.json;
//   - browser consent with PKCE (S256) and a random `state`, the redirect
//     caught by a one-shot loopback server on 127.0.0.1:<random port>;
//   - scope calendar.readonly - this module cannot change the calendar;
//   - the refresh token is stored encrypted with Electron safeStorage in
//     gcal-token.local.json. No safeStorage -> it lives in memory only and
//     the user reconnects after a restart; it is never written in clear.
//
// Every value from Google is untrusted: events are rebuilt field by field,
// capped, and validated with the same rules as the rest of missioncal.js.
// ============================================================================

'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const paths = require('./paths');
const { clampString } = require('./missionrunner');
const { validTime, compareEvents } = require('./missioncal');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const CLIENT_FILE = 'google-oauth.local.json';
const TOKEN_FILE = 'gcal-token.local.json';

const CONSENT_TIMEOUT_MS = 180000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CALENDARS = 25;
const MAX_PAGES = 5;
const PAGE_SIZE = 250;
const MAX_EVENTS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_NAME_CHARS = 80;
const DEFAULT_TTL_MS = 3600000;
// Refresh a little before Google's expiry, not on the failed request after it.
const EXPIRY_SLACK_MS = 60000;

const CLIENT_ID_RE = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;
const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Typed failure; the IPC layer hands `reason` to the renderer. */
class GcalError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}

/**
 * The OAuth client from Google's downloaded JSON ({installed:{...}}) or a flat
 * {client_id, client_secret}. Null when missing or malformed.
 */
function parseClientFile(raw) {
  const c = raw && typeof raw === 'object' ? raw.installed || raw : null;
  if (!c || typeof c.client_id !== 'string' || !CLIENT_ID_RE.test(c.client_id)) return null;
  // A Desktop client's secret is not confidential (Google says so), but the
  // token endpoint still requires it.
  if (typeof c.client_secret !== 'string' || !c.client_secret || c.client_secret.length > 200) return null;
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    // Forces a refresh token even when the user consented before.
    prompt: 'consent',
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Rebuilds one API event into the widget's shape. Null for cancelled events,
 * events the user declined, and anything with unusable times.
 * @param {object} raw  an events#resource from the API
 * @param {{name:string, color:string|null}} calendar
 * @param {Array<{id:string, colorId:string|null}>} categories
 */
function normalizeEvent(raw, calendar, categories) {
  if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') return null;
  const self = Array.isArray(raw.attendees) ? raw.attendees.find((a) => a && a.self) : null;
  if (self && self.responseStatus === 'declined') return null;
  const s = raw.start || {};
  const e = raw.end || {};
  const allDay = typeof s.date === 'string';
  const start = validTime(allDay ? s.date : s.dateTime, allDay);
  if (!start) return null;
  const category = categories.find((c) => c.colorId && c.colorId === raw.colorId);
  return {
    id: typeof raw.id === 'string' && EVENT_ID_RE.test(raw.id) ? raw.id : '',
    uid: typeof raw.iCalUID === 'string' ? raw.iCalUID.slice(0, 300) : '',
    title: clampString(raw.summary, MAX_TITLE_CHARS) || '(no title)',
    start,
    end: validTime(allDay ? e.date : e.dateTime, allDay) || start,
    allDay,
    location: clampString(raw.location, MAX_TEXT_CHARS),
    category: category ? category.id : null,
    calendar: calendar.name,
    color: calendar.color,
  };
}

/**
 * Merges per-calendar event lists: one copy of an event that sits in two
 * calendars (an invite on both Praca and primary), sorted, capped.
 */
function mergeEvents(lists) {
  const seen = new Set();
  const out = [];
  for (const { uid, ...ev } of lists.flat()) {
    const key = uid ? `${uid}|${ev.start}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(ev);
  }
  return out.sort(compareEvents).slice(0, MAX_EVENTS);
}

/** The calendars shown in Google Calendar (ticked in its sidebar). */
function visibleCalendars(items) {
  return (Array.isArray(items) ? items : [])
    .filter((c) => c && typeof c.id === 'string' && c.id && (c.selected === true || c.primary === true))
    .slice(0, MAX_CALENDARS)
    .map((c) => ({
      id: c.id,
      name: clampString(c.summaryOverride || c.summary, MAX_NAME_CHARS) || c.id.slice(0, MAX_NAME_CHARS),
      color: typeof c.backgroundColor === 'string' && HEX_RE.test(c.backgroundColor) ? c.backgroundColor : null,
    }));
}

const tokenTtl = (body) => (Number.isFinite(body.expires_in) ? body.expires_in * 1000 : DEFAULT_TTL_MS);

/** Page shown in the browser tab after Google redirects back. Static text only. */
const doneHtml = (ok) =>
  '<!doctype html><meta charset="utf-8"><title>LunaCore</title>' +
  '<body style="font:16px system-ui;padding:2rem">' +
  (ok ? 'LunaCore is connected to Google Calendar. You can close this tab.' : 'Access was not granted.') +
  '</body>';

/**
 * Starts a one-shot loopback server and resolves once it listens.
 * @returns {Promise<{redirectUri:string, code:Promise<string>, close:()=>void}>}
 */
function startRedirectServer(state) {
  return new Promise((ready, fail) => {
    let settle;
    const code = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    // The redirect can land before the caller awaits `code` (e.g. a refusal
    // while openExternal is still resolving); the rejection is still seen by
    // that later await, it just must not count as unhandled meanwhile.
    code.catch(() => {});
    let timer = null;
    let done = false;
    // Idempotent: the redirect, the timeout and close() may all race here.
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      fn(value);
    };
    const server = http.createServer((req, res) => {
      if (done) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      // Favicon probes, stray requests, a wrong state: not our redirect.
      if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }
      const value = url.searchParams.get('code');
      res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        })
        .end(doneHtml(!!value));
      if (value) finish(settle.resolve, value);
      else finish(settle.reject, new GcalError('gcal-denied', url.searchParams.get('error') || 'no code'));
    });
    server.on('error', (err) => fail(new GcalError('gcal-failed', err.message)));
    server.listen(0, '127.0.0.1', () => {
      timer = setTimeout(() => finish(settle.reject, new GcalError('gcal-timeout')), CONSENT_TIMEOUT_MS);
      const close = () => finish(settle.reject, new GcalError('gcal-failed', 'closed'));
      ready({ redirectUri: `http://127.0.0.1:${server.address().port}`, code, close });
    });
  });
}

/**
 * @param {{fetchImpl?:Function, openExternal?:Function, safeStorage?:object,
 *   clientPath?:string, tokenPath?:string}} [deps]
 *   Injectable so tests never touch the network, a browser, the keychain or
 *   the real config folder.
 */
function createGcal(deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  const openExternal = deps.openExternal || ((url) => require('electron').shell.openExternal(url));
  const storage = () => deps.safeStorage || require('electron').safeStorage;
  const tokenFile = () => deps.tokenPath || paths.local(TOKEN_FILE);
  const loadClient = () => parseClientFile(readJson(deps.clientPath || paths.local(CLIENT_FILE)));

  let refreshToken = null;
  let access = null; // { token, expiresAt }
  let loaded = false;

  function loadRefreshToken() {
    if (loaded) return refreshToken;
    loaded = true;
    const raw = readJson(tokenFile());
    if (!raw || raw.v !== 1 || typeof raw.enc !== 'string') return null;
    try {
      const ss = storage();
      if (ss.isEncryptionAvailable()) refreshToken = ss.decryptString(Buffer.from(raw.enc, 'base64')) || null;
    } catch (err) {
      console.error('[gcal] stored token unreadable:', err && err.message);
    }
    return refreshToken;
  }

  function saveRefreshToken(token) {
    refreshToken = token;
    loaded = true;
    try {
      const ss = storage();
      if (!ss.isEncryptionAvailable()) return; // memory only, by design
      if (!deps.tokenPath) paths.ensureUserDir();
      const enc = ss.encryptString(token).toString('base64');
      // Temp + rename: a crash mid-write never leaves a torn token file. The
      // temp name still ends in .local.json, so the gitignore covers a leftover.
      const tmp = tokenFile().replace(/(\.local)?\.json$/,'.tmp.local.json');
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc }), { mode: 0o600 });
      fs.renameSync(tmp, tokenFile());
    } catch (err) {
      console.error('[gcal] could not store token:', err && err.message);
    }
  }

  function forget() {
    refreshToken = null;
    access = null;
    loaded = true;
    try {
      fs.rmSync(tokenFile(), { force: true });
    } catch (err) {
      console.error('[gcal] could not remove token:', err && err.message);
    }
  }

  async function postToken(params) {
    let res;
    try {
      res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GcalError('gcal-network', err && err.message);
    }
    const body = await res.json().catch(() => ({}));
    // invalid_grant = the refresh token was revoked or has expired.
    if (!res.ok) throw new GcalError(body.error === 'invalid_grant' ? 'gcal-auth' : 'gcal-failed', String(body.error));
    return body;
  }

  async function accessToken() {
    if (access && access.expiresAt > Date.now()) return access.token;
    const client = loadClient();
    if (!client) throw new GcalError('gcal-no-client');
    if (!loadRefreshToken()) throw new GcalError('gcal-not-connected');
    let body;
    try {
      body = await postToken({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    } catch (err) {
      // A dead refresh token stays dead; drop it so the UI offers Connect.
      if (err.reason === 'gcal-auth') forget();
      throw err;
    }
    if (typeof body.access_token !== 'string') throw new GcalError('gcal-failed', 'no access_token');
    access = { token: body.access_token, expiresAt: Date.now() + tokenTtl(body) - EXPIRY_SLACK_MS };
    return access.token;
  }

  async function apiGet(path, query) {
    const token = await accessToken();
    let res;
    try {
      res = await doFetch(`${API}${path}?${new URLSearchParams(query)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GcalError('gcal-network', err && err.message);
    }
    if (res.status === 401) {
      access = null;
      throw new GcalError('gcal-failed', 'access token rejected');
    }
    if (!res.ok) throw new GcalError('gcal-failed', `HTTP ${res.status} on ${path}`);
    return res.json();
  }

  async function calendarEvents(cal, fromIso, toIso, categories) {
    const out = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = {
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      };
      const body = await apiGet(`/calendars/${encodeURIComponent(cal.id)}/events`, query);
      for (const raw of Array.isArray(body.items) ? body.items : []) {
        const ev = normalizeEvent(raw, cal, categories);
        if (ev) out.push(ev);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * Every event overlapping [from, to) across the visible calendars. The API's
   * timeMin/timeMax overlap rule already includes events that started before
   * the window and are still running in it.
   */
  async function listEvents({ fromIso, toIso, categories }) {
    const list = await apiGet('/users/me/calendarList', { minAccessRole: 'reader', maxResults: '250' });
    const cals = visibleCalendars(list.items);
    const lists = await Promise.all(cals.map((c) => calendarEvents(c, fromIso, toIso, categories)));
    return { events: mergeEvents(lists) };
  }

  async function connect() {
    const client = loadClient();
    if (!client) throw new GcalError('gcal-no-client');
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const { redirectUri, code, close } = await startRedirectServer(state);
    let body;
    try {
      try {
        await openExternal(buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge }));
      } catch (err) {
        throw new GcalError('gcal-failed', `could not open the browser: ${err && err.message}`);
      }
      // GcalError messages carry fetch/network text only - never the request
      // body, which holds the code verifier and client secret.
      body = await postToken({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: await code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
    } finally {
      close();
    }
    if (typeof body.refresh_token !== 'string') throw new GcalError('gcal-failed', 'no refresh_token');
    saveRefreshToken(body.refresh_token);
    if (typeof body.access_token === 'string') {
      access = { token: body.access_token, expiresAt: Date.now() + tokenTtl(body) - EXPIRY_SLACK_MS };
    }
  }

  const status = () => ({ configured: !!loadClient(), connected: !!loadRefreshToken() });

  return { status, connect, listEvents };
}

module.exports = {
  createGcal,
  GcalError,
  parseClientFile,
  buildAuthUrl,
  normalizeEvent,
  mergeEvents,
  visibleCalendars,
  startRedirectServer,
  CLIENT_FILE,
  SCOPE,
};
