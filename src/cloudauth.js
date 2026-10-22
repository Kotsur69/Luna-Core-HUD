// ============================================================================
// LunaCore - cloud login (main)
// ----------------------------------------------------------------------------
// GitHub login through Supabase Auth (docs/DONE_CLOUD_SYNC_PLAN.md, phase 2a), the
// flow proven by the phase 1 probe:
//
//   signInWithOAuth({skipBrowserRedirect}) -> the authorize URL, checked to be
//   our own project -> system browser -> GitHub -> Supabase -> loopback
//   http://127.0.0.1:<random port>/callback?code=... -> exchangeCodeForSession
//
// PKCE: the code verifier sits in the storage below, so a code caught by
// anything else on this PC is useless. The loopback server lives only for one
// login and is closed after it (or after the timeout).
//
// The session (access + refresh token) is stored encrypted with Electron
// safeStorage in cloud-session.local.json, same pattern as lifeyazio.js. No
// safeStorage -> no login at all (a plaintext refresh token is never written).
// Tokens never leave the main process: status() reports only who is logged in.
// ============================================================================

'use strict';

const fs = require('fs');
const http = require('http');

const VERSION = 1;
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
/** Supabase codes are short; anything longer is not one. */
const MAX_CODE_LEN = 512;
const DONE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>LunaCore</title>' +
  '<body style="font-family:system-ui;background:#111;color:#eee;text-align:center;padding-top:20vh">' +
  '<p>LunaCore: you can close this tab.</p></body>';

class LoginError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Key-value storage for supabase-js, backed by one encrypted file.
 * @returns {{getItem, setItem, removeItem, clear}}
 */
function encryptedStorage(file, safeStorage) {
  let mem = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.v === VERSION && typeof raw.enc === 'string' && safeStorage.isEncryptionAvailable()) {
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, 'base64')));
      if (data && typeof data === 'object' && !Array.isArray(data)) mem = data;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[cloudauth] stored session unreadable:', err.code || err.name);
  }

  // Never throws into supabase-js: a failed write (AV lock, EPERM) keeps the
  // session in memory for this run instead of failing a login or refresh.
  function persist() {
    try {
      if (!Object.keys(mem).length) return fs.rmSync(file, { force: true });
      if (!safeStorage.isEncryptionAvailable()) return; // memory only, never plaintext
      const enc = safeStorage.encryptString(JSON.stringify(mem)).toString('base64');
      const tmp = file.replace(/(\.local)?\.json$/, '.tmp.local.json');
      fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, enc }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[cloudauth] could not store session:', (err && (err.code || err.name)) || 'error');
    }
  }

  return {
    getItem: (k) => (Object.hasOwn(mem, k) ? mem[k] : null),
    setItem: (k, v) => {
      mem = { ...mem, [k]: String(v) };
      persist();
    },
    removeItem: (k) => {
      const { [k]: _gone, ...rest } = mem;
      mem = rest;
      persist();
    },
    clear: () => {
      mem = {};
      persist();
    },
  };
}

/** Starts the loopback server; resolves {redirectTo, code: Promise<string>, close}. */
function loopback(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settle;
    const code = new Promise((res, rej) => (settle = { res, rej }));
    code.catch(() => {}); // handled by the caller; never an unhandled rejection
    let host = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const got = url.searchParams.get('code');
      const denied = url.searchParams.get('error');
      // Only the browser redirect counts: right path and Host (no DNS
      // rebinding), and a code or an error. Stray probes cannot end the login.
      if (req.method !== 'GET' || url.pathname !== '/callback' || req.headers.host !== host || !(got || denied)) {
        res.writeHead(404).end();
        return;
      }
      if (got && got.length > MAX_CODE_LEN) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
      if (got) settle.res(got);
      else settle.rej(new LoginError('denied'));
    });
    const timer = setTimeout(() => settle.rej(new LoginError('timeout')), timeoutMs);
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    };
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      host = `127.0.0.1:${server.address().port}`;
      resolve({ redirectTo: `http://${host}/callback`, code, close });
    });
  });
}

/**
 * @param {{config: {url, publishableKey}, sessionFile: string, safeStorage?: object,
 *   shell?: {openExternal: Function}, createClient?: Function, loginTimeoutMs?: number}} deps
 *   Electron's safeStorage / shell and supabase-js are the defaults; tests inject fakes.
 */
function createCloudAuth({ config, sessionFile, safeStorage, shell, createClient, loginTimeoutMs = LOGIN_TIMEOUT_MS }) {
  const ss = safeStorage || require('electron').safeStorage;
  const make = createClient || require('@supabase/supabase-js').createClient;
  const storage = encryptedStorage(sessionFile, ss);
  const client = make(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  let session = null;
  let inflight = null;
  const listeners = [];

  // No awaits on other auth calls in here: supabase-js holds a lock while it runs.
  client.auth.onAuthStateChange((_event, next) => {
    const was = Boolean(session);
    session = next || null;
    if (was !== Boolean(session)) listeners.forEach((cb) => cb(Boolean(session)));
  });

  const isOurAuthorizeUrl = (raw) => {
    try {
      const u = new URL(raw);
      return u.origin === new URL(config.url).origin && u.pathname === '/auth/v1/authorize';
    } catch {
      return false;
    }
  };

  async function doLogin() {
    if (!ss.isEncryptionAvailable()) throw new LoginError('no-encryption');
    const lb = await loopback(loginTimeoutMs);
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: lb.redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data || !isOurAuthorizeUrl(data.url)) throw new LoginError('failed');
      await (shell || require('electron').shell).openExternal(data.url);
      const code = await lb.code;
      const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
      if (exchangeError) throw new LoginError('failed');
    } finally {
      lb.close();
    }
  }

  return {
    client,
    /** Loads the stored session (refreshes it when expired). */
    async init() {
      try {
        const { data } = await client.auth.getSession();
        session = (data && data.session) || null;
      } catch (err) {
        console.error('[cloudauth] session check failed:', (err && (err.code || err.name)) || 'error');
      }
    },
    /** @returns {Promise<{ok: true} | {ok: false, reason: string}>} one login at a time */
    login() {
      if (inflight) return inflight;
      inflight = doLogin()
        .then(() => ({ ok: true }))
        .catch((err) => {
          if (!(err instanceof LoginError)) console.error('[cloudauth] login failed:', (err && (err.code || err.name)) || 'error');
          return { ok: false, reason: err instanceof LoginError ? err.reason : 'failed' };
        })
        .finally(() => (inflight = null));
      return inflight;
    },
    async logout() {
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch (err) {
        console.error('[cloudauth] sign-out failed:', (err && (err.code || err.name)) || 'error');
      }
      storage.clear();
      if (session) {
        session = null;
        listeners.forEach((cb) => cb(false));
      }
    },
    status() {
      const user = session && session.user;
      const meta = (user && user.user_metadata) || {};
      return { configured: true, loggedIn: Boolean(session), user: user ? String(meta.user_name || user.email || '') : null };
    },
    /** The logged-in user's id (scopes the local sync state), or null. */
    userId() {
      const id = session && session.user && session.user.id;
      return typeof id === 'string' ? id : null;
    },
    /** cb(loggedIn) on every login / logout. */
    onChange(cb) {
      listeners.push(cb);
    },
  };
}

module.exports = { createCloudAuth };
