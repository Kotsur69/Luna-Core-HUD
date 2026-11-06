// OAuth refresh for a usage-only Claude login (src/claudeoauthrefresh.js).
//
// Why this file matters: it writes credential files. It must send the same
// grant the CLI sends, keep every other field, keep a rotated refresh token,
// write atomically, refuse the main ~/.claude login and never hand a token back.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { refreshUsageLogin, writeFileAtomic, TOKEN_HOST, TOKEN_PATH, CLIENT_ID } = require('../src/claudeoauthrefresh');

const NOW = Date.UTC(2026, 10, 6, 9);
// Fake tokens are assembled at runtime, never written as one literal.
const fake = (tag) => ['tok', tag, 'y'.repeat(20)].join('-');

const DIR = path.join(os.tmpdir(), 'lc-oauth-home', '.claude-usage-a');
const FILE = path.join(DIR, '.credentials.json');

const stored = () => ({
  claudeAiOauth: {
    accessToken: fake('old-at'),
    refreshToken: fake('old-rt'),
    expiresAt: NOW - 1000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'tier-x',
  },
  mcpOAuth: { keep: true },
});

function fakeFs(initial = stored()) {
  const files = new Map([[FILE, JSON.stringify(initial)]]);
  const writes = [];
  return {
    files,
    writes,
    readFile: (f) => {
      if (!files.has(f)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(f);
    },
    writeFile: (f, text) => {
      writes.push(f);
      files.set(f, text);
    },
  };
}

const okGrant = (extra = {}) => async () => ({
  status: 200,
  body: JSON.stringify({ access_token: fake('new-at'), refresh_token: fake('new-rt'), expires_in: 28800, ...extra }),
});

test('sends the CLI refresh grant and writes the new tokens, keeping every other field', async () => {
  const f = fakeFs();
  const posts = [];
  const res = await refreshUsageLogin({
    dir: DIR,
    readFile: f.readFile,
    writeFile: f.writeFile,
    now: () => NOW,
    post: async (host, pathname, payload) => {
      posts.push({ host, pathname, payload });
      return okGrant({ refresh_token_expires_in: 3600 })();
    },
  });
  assert.deepEqual(res, { ok: true });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].host, TOKEN_HOST);
  assert.equal(posts[0].pathname, TOKEN_PATH);
  assert.deepEqual(posts[0].payload, {
    grant_type: 'refresh_token',
    refresh_token: fake('old-rt'),
    client_id: CLIENT_ID,
    scope: 'user:profile user:inference',
  });
  const saved = JSON.parse(f.files.get(FILE));
  assert.deepEqual(saved.mcpOAuth, { keep: true });
  assert.equal(saved.claudeAiOauth.accessToken, fake('new-at'));
  assert.equal(saved.claudeAiOauth.refreshToken, fake('new-rt'), 'a rotated refresh token is kept');
  assert.equal(saved.claudeAiOauth.expiresAt, NOW + 28800 * 1000);
  assert.equal(saved.claudeAiOauth.refreshTokenExpiresAt, NOW + 3600 * 1000);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'max');
  assert.equal(saved.claudeAiOauth.rateLimitTier, 'tier-x');
});

test('no refresh_token in the answer keeps the old one', async () => {
  const f = fakeFs();
  const post = async () => ({ status: 200, body: JSON.stringify({ access_token: fake('new-at'), expires_in: 60 }) });
  assert.deepEqual(await refreshUsageLogin({ dir: DIR, ...f, post, now: () => NOW }), { ok: true });
  assert.equal(JSON.parse(f.files.get(FILE)).claudeAiOauth.refreshToken, fake('old-rt'));
});

test('stored scopes missing -> the CLI default scope list', async () => {
  const cred = stored();
  delete cred.claudeAiOauth.scopes;
  const f = fakeFs(cred);
  let scope = null;
  const post = async (h, p, payload) => { scope = payload.scope; return okGrant()(); };
  await refreshUsageLogin({ dir: DIR, ...f, post, now: () => NOW });
  assert.match(scope, /user:profile/);
  assert.match(scope, /user:inference/);
});

test('the main ~/.claude login is refused before anything is read or sent', async () => {
  let touched = false;
  const res = await refreshUsageLogin({
    dir: path.join(os.tmpdir(), 'lc-oauth-home', '.claude'),
    readFile: () => { touched = true; return '{}'; },
    writeFile: () => { touched = true; },
    post: async () => { touched = true; return { status: 200, body: '' }; },
  });
  assert.deepEqual(res, { ok: false, error: 'mainDir' });
  assert.equal(touched, false);
});

test('400/401 -> rejected, other statuses -> http, junk body -> badResponse; nothing written', async () => {
  const cases = [
    [400, '{"error":"invalid_grant"}', 'rejected'],
    [401, '', 'rejected'],
    [429, '', 'http'],
    [503, '', 'http'],
    [0, '', 'http'],
    [200, 'not json', 'badResponse'],
    [200, JSON.stringify({ access_token: '', expires_in: 10 }), 'badResponse'],
    [200, JSON.stringify({ access_token: fake('x'), expires_in: 'soon' }), 'badResponse'],
    [200, JSON.stringify({ access_token: fake('x'), expires_in: 1e300 }), 'badResponse'],
    [200, JSON.stringify({ access_token: 'has space', expires_in: 60 }), 'badResponse'],
    [200, JSON.stringify({ access_token: 'a'.repeat(9000), expires_in: 60 }), 'badResponse'],
    [200, JSON.stringify({ access_token: fake('x'), refresh_token: 'line\nbreak', expires_in: 60 }), 'badResponse'],
  ];
  for (const [status, body, error] of cases) {
    const f = fakeFs();
    const res = await refreshUsageLogin({ dir: DIR, ...f, post: async () => ({ status, body }), now: () => NOW });
    assert.deepEqual(res, { ok: false, error }, `status ${status}`);
    assert.equal(f.writes.length, 0);
  }
});

test('a throwing POST is an http error, never a crash', async () => {
  const f = fakeFs();
  const res = await refreshUsageLogin({ dir: DIR, ...f, post: async () => { throw new Error('boom'); } });
  assert.deepEqual(res, { ok: false, error: 'http' });
});

test('no refresh token (missing file, corrupt, or field absent) -> noRefreshToken, nothing sent', async () => {
  let sent = 0;
  const post = async () => { sent += 1; return okGrant()(); };
  const missing = await refreshUsageLogin({ dir: DIR, readFile: () => { throw new Error('ENOENT'); }, post });
  const corrupt = await refreshUsageLogin({ dir: DIR, readFile: () => '{not json', post });
  const cred = stored();
  delete cred.claudeAiOauth.refreshToken;
  const absent = await refreshUsageLogin({ dir: DIR, readFile: () => JSON.stringify(cred), post });
  for (const r of [missing, corrupt, absent]) assert.deepEqual(r, { ok: false, error: 'noRefreshToken' });
  assert.equal(sent, 0);
});

test('a failed write -> writeFailed, and no result ever carries a token', async () => {
  const f = fakeFs();
  const res = await refreshUsageLogin({
    dir: DIR,
    readFile: f.readFile,
    writeFile: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    post: okGrant(),
  });
  assert.deepEqual(res, { ok: false, error: 'writeFailed' });
  const json = JSON.stringify(res);
  for (const t of ['old-at', 'old-rt', 'new-at', 'new-rt']) assert.ok(!json.includes(fake(t)));
});

test('a failed write keeps the grant: the retry only writes and never POSTs the old refresh token again', async () => {
  const f = fakeFs();
  const pending = new Map();
  let posts = 0;
  const post = async () => { posts += 1; return okGrant()(); };
  let failWrite = true;
  const writeFile = (file, text) => {
    if (failWrite) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    f.writeFile(file, text);
  };
  const first = await refreshUsageLogin({ dir: DIR, readFile: f.readFile, writeFile, post, now: () => NOW, pending });
  assert.deepEqual(first, { ok: false, error: 'writeFailed' });
  failWrite = false;
  const second = await refreshUsageLogin({ dir: DIR, readFile: f.readFile, writeFile, post, now: () => NOW, pending });
  assert.deepEqual(second, { ok: true });
  assert.equal(posts, 1, 'the token endpoint is called once');
  assert.equal(JSON.parse(f.files.get(FILE)).claudeAiOauth.refreshToken, fake('new-rt'));
  assert.equal(pending.size, 0);
});

test('a reconnect that lands during the POST is not clobbered', async () => {
  const f = fakeFs();
  const reconnected = stored();
  reconnected.claudeAiOauth.refreshToken = fake('reconnect-rt');
  reconnected.claudeAiOauth.accessToken = fake('reconnect-at');
  const post = async () => {
    f.files.set(FILE, JSON.stringify(reconnected)); // `claude auth login` wrote meanwhile
    return okGrant()();
  };
  const res = await refreshUsageLogin({ dir: DIR, ...f, post, now: () => NOW });
  assert.deepEqual(res, { ok: false, error: 'changed' });
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(f.files.get(FILE)).claudeAiOauth.accessToken, fake('reconnect-at'));
});

test('a pending grant is dropped once the file holds a different login', async () => {
  const f = fakeFs();
  const pending = new Map([[DIR, { sent: fake('gone-rt'), fields: { accessToken: fake('stale-at') } }]]);
  let posts = 0;
  const post = async () => { posts += 1; return okGrant()(); };
  const res = await refreshUsageLogin({ dir: DIR, ...f, post, now: () => NOW, pending });
  assert.deepEqual(res, { ok: true });
  assert.equal(posts, 1, 'the stale grant is not written; a fresh one is requested');
  assert.equal(JSON.parse(f.files.get(FILE)).claudeAiOauth.accessToken, fake('new-at'));
});

test('writeFileAtomic replaces the file and leaves no temp file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-atomic-'));
  try {
    const file = path.join(dir, '.credentials.json');
    fs.writeFileSync(file, '{"old":true}');
    await writeFileAtomic(file, '{"new":true}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}');
    assert.deepEqual(fs.readdirSync(dir), ['.credentials.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic failure keeps the old file and cleans up the temp file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-atomic-'));
  try {
    // The target is a non-empty directory, so the rename over it fails.
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    await assert.rejects(() => writeFileAtomic(target, 'data'));
    assert.deepEqual(fs.readdirSync(dir), ['target'], 'no temp file left behind');
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
