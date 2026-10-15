// ============================================================================
// LunaCore - cloud login (src/cloudauth.js)
// ----------------------------------------------------------------------------
// GitHub via Supabase PKCE: system browser + loopback redirect. The session
// is stored encrypted only; no encryption -> no login. A redirect URL that is
// not our Supabase project is never opened.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCloudAuth } = require('../src/cloudauth.js');

const CONFIG = { url: 'https://abc.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnop' };

/** Reversible stand-in for Electron safeStorage. */
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
});

/** A supabase-js stand-in that records the calls and uses the storage it was given. */
function fakeCreateClient(opts = {}) {
  const made = {};
  const createClient = (url, key, options) => {
    const listeners = [];
    let session = null;
    const storage = options.auth.storage;
    const emit = (evt) => listeners.forEach((cb) => cb(evt, session));
    made.options = options;
    made.client = {
      auth: {
        onAuthStateChange: (cb) => (listeners.push(cb), { data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session }, error: null }),
        signInWithOAuth: async ({ provider, options: o }) => {
          made.redirectTo = o.redirectTo;
          assert.equal(provider, 'github');
          assert.equal(o.skipBrowserRedirect, true);
          await storage.setItem('sb-abc-auth-token-code-verifier', 'verifier');
          return { data: { url: opts.authUrl || `${url}/auth/v1/authorize?provider=github` }, error: null };
        },
        exchangeCodeForSession: async (code) => {
          made.code = code;
          if (code === 'bad') return { data: {}, error: { message: 'nope' } };
          session = { user: { email: 'm@x', user_metadata: { user_name: 'Kotsur69' } } };
          await storage.setItem('sb-abc-auth-token', JSON.stringify(session));
          emit('SIGNED_IN');
          return { data: { session }, error: null };
        },
        signOut: async () => {
          session = null;
          await storage.removeItem('sb-abc-auth-token');
          emit('SIGNED_OUT');
          return { error: null };
        },
      },
    };
    return made.client;
  };
  return { createClient, made };
}

function setup({ available = true, authUrl, browser } = {}) {
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cauth-')), 'cloud-session.local.json');
  const { createClient, made } = fakeCreateClient({ authUrl });
  const opened = [];
  // The "browser": follows the redirect the way GitHub + Supabase would.
  const shell = {
    openExternal: async (url) => {
      opened.push(url);
      if (browser) await browser(made.redirectTo);
      else fetch(`${made.redirectTo}?code=good`).catch(() => {});
    },
  };
  const auth = createCloudAuth({ config: CONFIG, sessionFile, safeStorage: fakeSafeStorage(available), shell, createClient, loginTimeoutMs: 2000 });
  return { auth, made, opened, sessionFile };
}

test('client is PKCE, persists the session, never reads it from a URL', () => {
  const { made } = setup();
  assert.equal(made.options.auth.flowType, 'pkce');
  assert.equal(made.options.auth.persistSession, true);
  assert.equal(made.options.auth.detectSessionInUrl, false);
});

test('login: loopback redirect on 127.0.0.1, code exchanged, session stored encrypted', async () => {
  const { auth, made, opened, sessionFile } = setup();
  await auth.init();
  assert.equal(auth.status().loggedIn, false);
  const res = await auth.login();
  assert.deepEqual(res, { ok: true });
  assert.match(made.redirectTo, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(opened.length, 1);
  assert.equal(made.code, 'good');
  assert.deepEqual(auth.status(), { configured: true, loggedIn: true, user: 'Kotsur69' });
  const raw = fs.readFileSync(sessionFile, 'utf8');
  assert.equal(raw.includes('Kotsur69'), false); // only the encrypted blob is on disk
  assert.equal(JSON.parse(raw).v, 1);
});

test('the stored session is read back by a new instance', async () => {
  const first = setup();
  await first.auth.login();
  const { createClient, made } = fakeCreateClient();
  createCloudAuth({ config: CONFIG, sessionFile: first.sessionFile, safeStorage: fakeSafeStorage(), shell: {}, createClient });
  assert.notEqual(await made.options.auth.storage.getItem('sb-abc-auth-token'), null);
});

test('no encryption: login refused, nothing written', async () => {
  const { auth, opened, sessionFile } = setup({ available: false });
  assert.deepEqual(await auth.login(), { ok: false, reason: 'no-encryption' });
  assert.equal(opened.length, 0);
  assert.equal(fs.existsSync(sessionFile), false);
});

test('an authorize URL outside our project is never opened', async () => {
  const { auth, opened } = setup({ authUrl: 'https://evil.example.com/auth/v1/authorize' });
  assert.deepEqual(await auth.login(), { ok: false, reason: 'failed' });
  assert.equal(opened.length, 0);
});

test('a provider error on the callback fails the login', async () => {
  const { auth } = setup({ browser: (r) => fetch(`${r}?error=access_denied`).catch(() => {}) });
  assert.deepEqual(await auth.login(), { ok: false, reason: 'denied' });
});

test('a refused code fails the login', async () => {
  const { auth } = setup({ browser: (r) => fetch(`${r}?code=bad`).catch(() => {}) });
  assert.deepEqual(await auth.login(), { ok: false, reason: 'failed' });
  assert.equal(auth.status().loggedIn, false);
});

test('no callback in time: timeout, the loopback port is closed', async () => {
  const { auth, made } = setup({ browser: async () => {} });
  const res = await auth.login();
  assert.deepEqual(res, { ok: false, reason: 'timeout' });
  await assert.rejects(fetch(`${made.redirectTo}?code=late`));
});

test('logout clears the session file', async () => {
  const { auth, sessionFile } = setup();
  await auth.login();
  await auth.logout();
  assert.equal(auth.status().loggedIn, false);
  assert.equal(fs.existsSync(sessionFile), false);
});

test('onChange hears login and logout', async () => {
  const { auth } = setup();
  const seen = [];
  auth.onChange((loggedIn) => seen.push(loggedIn));
  await auth.login();
  await auth.logout();
  assert.deepEqual(seen, [true, false]);
});

test('stray requests to the loopback port cannot end or hijack the login', async () => {
  const { auth, made } = setup({
    browser: async (r) => {
      const port = new URL(r).port;
      assert.equal((await fetch(r)).status, 404); // no code, no error
      assert.equal((await fetch(`http://127.0.0.1:${port}/other?code=x`)).status, 404);
      assert.equal((await fetch(`${r}?code=${'a'.repeat(600)}`)).status, 400);
      fetch(`${r}?code=good`).catch(() => {});
    },
  });
  assert.deepEqual(await auth.login(), { ok: true });
  assert.equal(made.code, 'good');
});

test('userId comes from the session only', () => {
  const { auth } = setup();
  assert.equal(auth.userId(), null);
});
