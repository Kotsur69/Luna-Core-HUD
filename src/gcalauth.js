// ============================================================================
// LunaCore - Google OAuth 2.0 for the Calendar client (split out of gcal.js)
// ----------------------------------------------------------------------------
// The installed-app flow gcal.js's header describes: the user's own Desktop
// OAuth client, browser consent with PKCE (S256) and a random `state`, the
// redirect caught by a one-shot loopback server, and the refresh token stored
// encrypted with Electron safeStorage (memory only when that is unavailable,
// never in clear).
//
// createGcalCredentials() owns the token state; gcal.js asks it for an access
// token and tells it when Google rejected one. gmailsend.js reuses the client
// file, the auth URL and the redirect server.
// ============================================================================

'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const paths = require('./paths');

const SCOPE = ['calendar.readonly', 'calendar.events'].map((s) => `https://www.googleapis.com/auth/${s}`).join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_FILE = 'google-oauth.local.json';
const TOKEN_FILE = 'gcal-token.local.json';

const CONSENT_TIMEOUT_MS = 180000;
/** A downloaded client JSON is ~400 bytes; anything this big is not one. */
const MAX_CLIENT_FILE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_TTL_MS = 3600000;
// Refresh a little before Google's expiry, not on the failed request after it.
const EXPIRY_SLACK_MS = 60000;

const CLIENT_ID_RE = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;

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

/** `scope` defaults to this module's; scripts/google-server-token.js asks for more. */
function buildAuthUrl({ clientId, redirectUri, state, challenge, scope = SCOPE }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    // Forces a refresh token even when the user consented before.
    prompt: 'consent',
  });
  return `${AUTH_URL}?${q}`;
}

const tokenTtl = (body) => (Number.isFinite(body.expires_in) ? body.expires_in * 1000 : DEFAULT_TTL_MS);

/** Page shown in the browser tab after Google redirects back. Static text only. */
const doneHtml = (ok) =>
  '<!doctype html><meta charset="utf-8"><title>LunaCore</title>' +
  '<body style="font:16px system-ui;padding:2rem">' +
  (ok ? 'LunaCore is connected to Google. You can close this tab.' : 'Access was not granted.') +
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
 * Token state for one calendar client.
 * @param {fetchImpl?:Function, openExternal?:Function, safeStorage?:object,
 *   clientPath?:string, tokenPath?:string} deps  see gcal.js's createGcal()
 * @param {onForget?:Function} [hooks]  onForget runs whenever the
 *   credentials are dropped, so the caller can clear what it derived from them.
 */
function createGcalCredentials(deps = {}, hooks = {}) {
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
    if (hooks.onForget) hooks.onForget();
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

  /** Google refused the current access token: fetch a fresh one next time. */
  function dropAccess() {
    access = null;
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

  /**
   * Takes the client JSON the user downloaded from Google Cloud (picked in a
   * native dialog by main) and saves only what this module needs. Anything
   * that is not a Desktop-app client is refused and the old file stays.
   */
  function importClient(file) {
    let raw = null;
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size <= MAX_CLIENT_FILE_BYTES) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = null;
    }
    const client = parseClientFile(raw && raw.installed ? raw : null);
    if (!client) throw new GcalError('gcal-bad-client');
    const dest = deps.clientPath || paths.local(CLIENT_FILE);
    if (!deps.clientPath) paths.ensureUserDir();
    fs.writeFileSync(
      dest,
      JSON.stringify({ installed: { client_id: client.clientId, client_secret: client.clientSecret } }, null, 2) + '\n',
      'utf8'
    );
  }

  return { status, connect, accessToken, dropAccess, forget, importClient };
}

module.exports = {
  createGcalCredentials,
  GcalError,
  parseClientFile,
  buildAuthUrl,
  startRedirectServer,
  base64url,
  readJson,
  CLIENT_FILE,
  SCOPE,
  FETCH_TIMEOUT_MS,
};
