// Per-account Claude usage (src/claudeaccountusage.js), the store's usageDir
// (src/claudeaccounts.js), its IPC (src/claudeaccountsipc.js) and the
// watcher hook (src/usage.js UsageWatcher.accountUsage).
//
// Why this file matters: the usage login's token must never leave main, a
// usageDir must never point outside the home dir, and one expired login must
// not blank the other accounts' bars.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccountUsage, parseAuthStatus, readCredentials, cleanEnv, usageDirFor } = require('../src/claudeaccountusage');
const { createClaudeAccounts, isUsageDirAllowed, isUsageDirFor, sanitize } = require('../src/claudeaccounts');
const { registerClaudeAccountsIpc } = require('../src/claudeaccountsipc');
const { UsageWatcher } = require('../src/usage');

const HOME = path.resolve(os.tmpdir(), 'lc-usage-home');
const MAIN_DIR = path.join(HOME, '.claude');
const NOW = Date.UTC(2026, 10, 5, 12);
const MIN = 60 * 1000;

// Fake tokens are assembled at runtime, never written as one literal.
const fakeToken = (tag) => ['tok', 'usage', tag, 'x'.repeat(24)].join('-');
const setupToken = (c) => [['sk', 'ant', 'oat01'].join('-'), c.repeat(40)].join('-');

const usageBody = (five, week) => JSON.stringify({
  five_hour: { utilization: five, resets_at: new Date(NOW + 2 * 60 * MIN).toISOString() },
  seven_day: { utilization: week, resets_at: new Date(NOW + 3 * 24 * 60 * MIN).toISOString() },
});

const refreshOf = (token) => ['rt', token].join('-');
const credFile = (token, expiresAt = NOW + 8 * 60 * MIN) => JSON.stringify({
  claudeAiOauth: { accessToken: token, refreshToken: refreshOf(token), expiresAt, scopes: ['user:profile'] },
});
/** A token endpoint that hands out `fresh` (and rotates the refresh token). */
const grantOk = (fresh) => () => ({
  status: 200,
  body: JSON.stringify({ access_token: fresh, refresh_token: refreshOf(fresh), expires_in: 8 * 3600 }),
});

/**
 * A fake world: files by path, targets as the store would list them, a GET
 * answering per token, an execFile recording every CLI call, a token
 * endpoint (`token(payload)`) and a file write recording every write.
 */
function world({ targets, files = {}, answers = {}, cli = {}, token = null, failWrite = false } = {}) {
  const fileMap = new Map(Object.entries(files));
  const calls = { fetch: [], exec: [], sleep: [], setUsage: [], connected: 0, post: [], write: [], log: [] };
  let list = targets;
  const accounts = {
    usageTargets: () => list,
    setUsage: (id, dir, email) => {
      calls.setUsage.push({ id, dir, email });
      list = list.map((t) => (t.id === id ? { ...t, usageDir: dir, usageEmail: email } : t));
      return { ok: true };
    },
  };
  const clock = { now: NOW };
  const usage = createAccountUsage({
    accounts,
    homeDir: () => HOME,
    readFile: (file) => {
      if (!fileMap.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return fileMap.get(file);
    },
    mkdir: () => {},
    postToken: async (host, pathname, payload) => {
      calls.post.push({ host, pathname, payload });
      return token ? token(payload) : { status: 0, body: '' };
    },
    writeFile: (file, text) => {
      calls.write.push(file);
      if (failWrite) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      fileMap.set(file, text);
    },
    log: (line) => { calls.log.push(line); },
    fetchUsage: async (token) => {
      calls.fetch.push(token);
      return answers[token] || { status: 0, body: '', headers: {} };
    },
    execFile: (bin, args, opts, cb) => {
      calls.exec.push({ bin, args, opts });
      const handler = cli[args.join(' ')];
      const out = handler ? handler(opts, fileMap) : { stdout: '' };
      setImmediate(() => cb(out.err || null, out.stdout || '', ''));
    },
    claudeBin: () => path.join(HOME, 'bin', 'claude.exe'),
    env: () => ({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: setupToken('z'), CLAUDE_CONFIG_DIR: MAIN_DIR }),
    now: () => clock.now,
    sleep: async (ms) => { calls.sleep.push(ms); },
    onConnected: () => { calls.connected += 1; },
  });
  return { usage, calls, clock, fileMap };
}

const dirOf = (id) => usageDirFor(HOME, id);
const credPath = (dir) => path.join(dir, '.credentials.json');

test('one entry per account with labels, the active marker and an unconnected one', async () => {
  const tGmail = fakeToken('gmail');
  const tOnet = fakeToken('onet');
  const w = world({
    targets: [
      { id: 'gmail', label: 'Gmail', active: true, usageDir: dirOf('gmail') },
      { id: 'onet', label: 'Onet', active: false, usageDir: dirOf('onet') },
      { id: 'spare', label: 'Spare', active: false, usageDir: null },
    ],
    files: { [credPath(dirOf('gmail'))]: credFile(tGmail), [credPath(dirOf('onet'))]: credFile(tOnet) },
    answers: { [tGmail]: { status: 200, body: usageBody(40, 10) }, [tOnet]: { status: 200, body: usageBody(90, 55) } },
  });
  const entries = await w.usage.read();
  assert.deepEqual(entries.map((e) => [e.accountId, e.label, e.active, e.status]), [
    ['gmail', 'Gmail', true, 'ok'],
    ['onet', 'Onet', false, 'ok'],
    ['spare', 'Spare', false, 'unconnected'],
  ]);
  assert.deepEqual(entries[1].limits.map((l) => [l.window, l.percentUsed]), [['5h', 90], ['weekly', 55]]);
  assert.deepEqual(entries[2].limits, []);
  // Staggered: one gap between the two GETs.
  assert.deepEqual(w.calls.sleep, [2000]);
});

test('401/403 marks only that account reconnect; the others keep updating', async () => {
  const tA = fakeToken('a');
  const tB = fakeToken('b');
  const tC = fakeToken('c');
  const w = world({
    targets: ['a', 'b', 'c'].map((id) => ({ id, label: id.toUpperCase(), active: id === 'a', usageDir: dirOf(id) })),
    files: { [credPath(dirOf('a'))]: credFile(tA), [credPath(dirOf('b'))]: credFile(tB), [credPath(dirOf('c'))]: credFile(tC) },
    answers: { [tA]: { status: 200, body: usageBody(5, 5) }, [tB]: { status: 401, body: '' }, [tC]: { status: 403, body: '' } },
    // B's 401 forces one refresh; its refresh token is dead too.
    token: () => ({ status: 400, body: '{"error":"invalid_grant"}' }),
  });
  const entries = await w.usage.read();
  assert.deepEqual(entries.map((e) => e.status), ['ok', 'reconnect', 'reconnect']);
  assert.equal(w.calls.post.length, 1, 'only the 401 tries a refresh, a 403 does not');
  assert.equal(entries[0].limits.length, 2);
  assert.deepEqual(entries[1].limits, []);
});

test('a transient error keeps the last bars (stale-while-error)', async () => {
  const tA = fakeToken('a');
  const answers = { [tA]: { status: 200, body: usageBody(12, 34) } };
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dirOf('a') }],
    files: { [credPath(dirOf('a'))]: credFile(tA) },
    answers,
  });
  await w.usage.read();
  answers[tA] = { status: 500, body: '' };
  const [entry] = await w.usage.read({ force: true });
  assert.equal(entry.status, 'error');
  assert.deepEqual(entry.limits.map((l) => l.percentUsed), [12, 34]);
});

test('a corrupt or missing credentials file does not crash - the account asks to reconnect', async () => {
  const w = world({
    targets: [
      { id: 'a', label: 'A', active: true, usageDir: dirOf('a') },
      { id: 'b', label: 'B', active: false, usageDir: dirOf('b') },
      { id: 'c', label: 'C', active: false, usageDir: dirOf('c') },
    ],
    files: { [credPath(dirOf('a'))]: '{not json', [credPath(dirOf('b'))]: JSON.stringify({ claudeAiOauth: { accessToken: 42 } }) },
  });
  const entries = await w.usage.read();
  assert.deepEqual(entries.map((e) => e.status), ['reconnect', 'reconnect', 'reconnect']);
  assert.equal(w.calls.fetch.length, 0);
  assert.equal(readCredentials(() => { throw new Error('EACCES'); }, dirOf('a')), null);
});

test('no token appears in any entry or watcher payload', async () => {
  const tA = fakeToken('secret-a');
  const tMain = fakeToken('secret-main');
  const w = world({
    targets: [
      { id: 'a', label: 'A', active: true, usageDir: dirOf('a') },
      { id: 'm', label: 'M', active: false, usageDir: MAIN_DIR },
    ],
    files: { [credPath(dirOf('a'))]: credFile(tA), [credPath(MAIN_DIR)]: credFile(tMain) },
    answers: { [tA]: { status: 200, body: usageBody(1, 2) }, [tMain]: { status: 401, body: '' } },
  });
  const payloads = [];
  const watcher = new UsageWatcher((u) => payloads.push(u));
  watcher.fetchPrimary = async () => ({ providerId: 'claude', status: 'error', limits: [], updatedAt: NOW });
  watcher.readOthers = async () => [];
  watcher.accountUsage = w.usage;
  await watcher.tick();
  watcher.stop();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].accounts.length, 2);
  const json = JSON.stringify(payloads[0]);
  assert.ok(!json.includes(tA) && !json.includes(tMain), 'a token leaked into usage:update');
  assert.ok(!json.includes('accessToken'));
});

test('the main ~/.claude login reuses the watcher read - no second GET', async () => {
  const w = world({ targets: [{ id: 'm', label: 'Main', active: true, usageDir: MAIN_DIR }] });
  const mainUsage = { providerId: 'claude', status: 'ok', isFallback: false, updatedAt: NOW, limits: [{ window: '5h', percentUsed: 33, resetsAt: null }] };
  const [entry] = await w.usage.read({ mainUsage });
  assert.equal(entry.status, 'ok');
  assert.equal(entry.main, true);
  assert.equal(entry.limits[0].percentUsed, 33);
  assert.equal(w.calls.fetch.length, 0);
});

test('an account is read at most once per interval unless forced', async () => {
  const tA = fakeToken('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dirOf('a') }],
    files: { [credPath(dirOf('a'))]: credFile(tA) },
    answers: { [tA]: { status: 200, body: usageBody(1, 1) } },
  });
  await w.usage.read();
  w.clock.now += 15 * 1000; // the watcher's error heartbeat
  await w.usage.read();
  assert.equal(w.calls.fetch.length, 1);
  await w.usage.read({ force: true });
  assert.equal(w.calls.fetch.length, 2);
});

test('an expired usage login is refreshed via OAuth and the bars come back - no Connect click', async () => {
  const old = fakeToken('old');
  const fresh = fakeToken('fresh');
  const dir = dirOf('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
    files: { [credPath(dir)]: credFile(old, NOW - 30 * MIN) },
    answers: { [old]: { status: 401, body: '' }, [fresh]: { status: 200, body: usageBody(7, 8) } },
    token: grantOk(fresh),
  });
  const [entry] = await w.usage.read();
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.limits.map((l) => l.percentUsed), [7, 8]);
  assert.deepEqual(w.calls.fetch, [fresh], 'the dead token is never sent to the usage GET');
  assert.equal(w.calls.exec.length, 0, 'the CLI is not run any more');
  assert.equal(w.calls.post.length, 1);
  assert.equal(w.calls.post[0].payload.refresh_token, refreshOf(old));
  assert.deepEqual(w.calls.write, [credPath(dir)]);
  const saved = JSON.parse(w.fileMap.get(credPath(dir))).claudeAiOauth;
  assert.equal(saved.accessToken, fresh);
  assert.equal(saved.refreshToken, refreshOf(fresh), 'a rotated refresh token is kept');
  assert.deepEqual(saved.scopes, ['user:profile'], 'other fields survive');
});

test('a token expiring within 10 min is refreshed before the GET', async () => {
  const old = fakeToken('soon');
  const fresh = fakeToken('soon-fresh');
  const dir = dirOf('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
    files: { [credPath(dir)]: credFile(old, NOW + 5 * MIN) },
    answers: { [fresh]: { status: 200, body: usageBody(1, 2) } },
    token: grantOk(fresh),
  });
  const [entry] = await w.usage.read();
  assert.equal(entry.status, 'ok');
  assert.deepEqual(w.calls.fetch, [fresh]);
});

test('a refresh answered 400/401 marks the account reconnect', async () => {
  for (const status of [400, 401]) {
    const old = fakeToken(`dead${status}`);
    const dir = dirOf('a');
    const w = world({
      targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
      files: { [credPath(dir)]: credFile(old, NOW - MIN) },
      token: () => ({ status, body: '{"error":"invalid_grant"}' }),
    });
    const [entry] = await w.usage.read();
    assert.equal(entry.status, 'reconnect', `status ${status}`);
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(w.calls.write.length, 0, 'nothing is written on a rejected refresh');
  }
});

test('a 401 from the usage GET forces one refresh and one retry', async () => {
  const old = fakeToken('revoked');
  const fresh = fakeToken('revoked-fresh');
  const dir = dirOf('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
    files: { [credPath(dir)]: credFile(old, NOW + 4 * 60 * MIN) },
    answers: { [old]: { status: 401, body: '' }, [fresh]: { status: 200, body: usageBody(3, 4) } },
    token: grantOk(fresh),
  });
  const [entry] = await w.usage.read();
  assert.equal(entry.status, 'ok');
  assert.deepEqual(w.calls.fetch, [old, fresh]);
});

test('a failed credentials write keeps the bars as an error, and logs no token', async () => {
  const old = fakeToken('wfail');
  const fresh = fakeToken('wfail-fresh');
  const dir = dirOf('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
    files: { [credPath(dir)]: credFile(old, NOW - MIN) },
    token: grantOk(fresh),
    failWrite: true,
  });
  const [entry] = await w.usage.read();
  assert.equal(entry.status, 'error');
  assert.equal(w.calls.fetch.length, 0);
  assert.equal(JSON.parse(w.fileMap.get(credPath(dir))).claudeAiOauth.accessToken, old, 'the file is untouched');
  const logs = w.calls.log.join('\n');
  assert.match(logs, /writeFailed/);
  for (const secret of [old, fresh, refreshOf(old), refreshOf(fresh)]) {
    assert.ok(!logs.includes(secret), 'a token leaked into the log');
  }
});

test('refresh never touches the main ~/.claude login, and a failing one is throttled', async () => {
  const tMain = fakeToken('main');
  const tA = fakeToken('a');
  const w = world({
    targets: [
      { id: 'm', label: 'M', active: true, usageDir: MAIN_DIR },
      { id: 'a', label: 'A', active: false, usageDir: dirOf('a') },
    ],
    files: { [credPath(MAIN_DIR)]: credFile(tMain, NOW - MIN), [credPath(dirOf('a'))]: credFile(tA, NOW - MIN) },
    answers: { [tMain]: { status: 401, body: '' } },
    token: () => ({ status: 503, body: '' }),
  });
  const [main, a] = await w.usage.read();
  assert.equal(w.calls.post.length, 1, 'only the usage login is refreshed');
  assert.equal(w.calls.post[0].payload.refresh_token, refreshOf(tA));
  for (const file of w.calls.write) assert.notEqual(path.resolve(file), path.resolve(credPath(MAIN_DIR)));
  assert.equal(main.status, 'reconnect');
  assert.equal(a.status, 'error', 'a transient refresh failure is not a reconnect');
  w.clock.now += 2 * MIN;
  const [, again] = await w.usage.read({ force: true });
  assert.equal(w.calls.post.length, 1, 'one refresh attempt per retry window');
  assert.equal(again.status, 'error');
  w.clock.now += 10 * MIN;
  await w.usage.read({ force: true });
  assert.equal(w.calls.post.length, 2, 'retried once the window passed');
});

test('a usage login connects and the email reads back (faked CLI)', async () => {
  const w = world({
    targets: [{ id: 'onet', label: 'Onet', active: false, usageDir: null }],
    cli: {
      'auth login': (opts, files) => {
        files.set(path.join(opts.env.CLAUDE_CONFIG_DIR, '.credentials.json'), credFile(fakeToken('new')));
        return { stdout: 'Opening browser...' };
      },
      'auth status': () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'mati@onet.pl' }) }),
    },
  });
  const res = await w.usage.connect('onet');
  assert.deepEqual(res, { ok: true, email: 'mati@onet.pl' });
  assert.deepEqual(w.calls.exec.map((c) => c.args.join(' ')), ['auth login', 'auth status']);
  assert.ok(w.calls.exec.every((c) => c.opts.env.CLAUDE_CONFIG_DIR === dirOf('onet')));
  assert.deepEqual(w.calls.setUsage, [{ id: 'onet', dir: dirOf('onet'), email: 'mati@onet.pl' }]);
  assert.equal(w.calls.connected, 1);
  const view = w.usage.decorate({ accounts: [{ id: 'onet', label: 'Onet' }] });
  assert.deepEqual(view.accounts[0].usage, { connected: true, main: false, email: 'mati@onet.pl', status: 'loading' });
});

test('connect refuses an unknown id, a second login at once, and a login that did not land', async () => {
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: null }],
    cli: { 'auth status': () => ({ stdout: JSON.stringify({ loggedIn: false }) }) },
  });
  assert.deepEqual(await w.usage.connect('../etc'), { ok: false, error: 'notFound' });
  assert.deepEqual(await w.usage.connect('nope'), { ok: false, error: 'notFound' });
  assert.deepEqual(await w.usage.connect('a'), { ok: false, error: 'loginFailed' });
  assert.equal(w.calls.setUsage.length, 0);
  const pending = w.usage.connect('a');
  assert.deepEqual(await w.usage.connect('a'), { ok: false, error: 'busy' });
  await pending;
});

test('connect reports a missing CLI and a timed-out login', async () => {
  const w = world({ targets: [{ id: 'a', label: 'A', active: true, usageDir: null }] });
  const noCli = createAccountUsage({
    accounts: { usageTargets: () => [{ id: 'a', label: 'A', active: true, usageDir: null }], setUsage: () => ({ ok: true }) },
    homeDir: () => HOME,
    mkdir: () => {},
    claudeBin: () => null,
  });
  assert.deepEqual(await noCli.connect('a'), { ok: false, error: 'noClaude' });
  const slow = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: null }],
    cli: { 'auth login': () => ({ err: Object.assign(new Error('timeout'), { killed: true }) }) },
  });
  assert.deepEqual(await slow.usage.connect('a'), { ok: false, error: 'timeout' });
  assert.ok(w);
});

test('"Use main login" points the account at ~/.claude without running the CLI', () => {
  const w = world({
    targets: [{ id: 'g', label: 'Gmail', active: true, usageDir: null }],
    files: { [credPath(MAIN_DIR)]: credFile(fakeToken('m')), [path.join(HOME, '.claude.json')]: JSON.stringify({ oauthAccount: { emailAddress: 'mati@gmail.com' } }) },
  });
  assert.deepEqual(w.usage.useMain('g'), { ok: true, email: 'mati@gmail.com' });
  assert.deepEqual(w.calls.setUsage, [{ id: 'g', dir: MAIN_DIR, email: 'mati@gmail.com' }]);
  assert.equal(w.calls.exec.length, 0);
  const none = world({ targets: [{ id: 'g', label: 'G', active: true, usageDir: null }] });
  assert.deepEqual(none.usage.useMain('g'), { ok: false, error: 'noMainLogin' });
});

test('parseAuthStatus reads JSON and plain text', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"email":"a@b.pl"}'), { loggedIn: true, email: 'a@b.pl' });
  assert.deepEqual(parseAuthStatus('noise\n{"loggedIn": true, "account": {"email": "x@y.com"}}\n'), { loggedIn: true, email: 'x@y.com' });
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), { loggedIn: false, email: null });
  assert.deepEqual(parseAuthStatus('Logged in as someone@example.com'), { loggedIn: true, email: 'someone@example.com' });
  assert.deepEqual(parseAuthStatus('Not logged in'), { loggedIn: false, email: null });
  assert.deepEqual(parseAuthStatus(undefined), { loggedIn: false, email: null });
});

test('cleanEnv drops backend, account and config-dir keys, case-insensitively', () => {
  const env = cleanEnv({ Path: 'p', anthropic_api_key: 'k', LUNACORE_CLAUDE_ACCOUNT: 'a', Claude_Config_Dir: MAIN_DIR }, dirOf('a'));
  assert.deepEqual(env, { Path: 'p', CLAUDE_CONFIG_DIR: dirOf('a') });
});

// ---- the store (src/claudeaccounts.js) -----------------------------------

test('usageDir outside the home dir is refused', () => {
  assert.equal(isUsageDirAllowed(path.join(HOME, '.claude-usage-a'), HOME), true);
  assert.equal(isUsageDirAllowed(MAIN_DIR, HOME), true);
  assert.equal(isUsageDirAllowed(HOME, HOME), false);
  assert.equal(isUsageDirAllowed(path.resolve(HOME, '..', 'elsewhere'), HOME), false);
  assert.equal(isUsageDirAllowed([HOME, '..', '..', 'x'].join(path.sep), HOME), false);
  assert.equal(isUsageDirAllowed([HOME, '.', 'x'].join(path.sep), HOME), false);
  assert.equal(isUsageDirAllowed('.claude', HOME), false);
  assert.equal(isUsageDirAllowed(HOME + path.sep + 'a' + String.fromCharCode(0) + 'b', HOME), false);
  assert.equal(isUsageDirAllowed(42, HOME), false);
});

test('a usageDir must be ~/.claude or the account\'s own ~/.claude-usage-<id>', () => {
  assert.equal(isUsageDirFor(path.join(HOME, '.claude-usage-a'), HOME, 'a'), true);
  assert.equal(isUsageDirFor(MAIN_DIR, HOME, 'a'), true);
  assert.equal(isUsageDirFor(path.join(HOME, '.claude-usage-b'), HOME, 'a'), false, 'another account\'s dir');
  assert.equal(isUsageDirFor(path.join(HOME, '.ssh'), HOME, 'a'), false);
  assert.equal(isUsageDirFor(path.join(HOME, '.claude-usage-a', 'nested'), HOME, 'a'), false);
  assert.equal(isUsageDirFor(path.join(HOME, '.claude-usage-a'), HOME, '../a'), false);
});

test('Windows path forms outside the allowlist are refused', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\me';
  assert.equal(isUsageDirFor('c:\\users\\ME\\.claude-usage-a', home, 'a'), true, 'case-insensitive');
  for (const bad of [
    'C:\\Users\\me\\..\\x\\.claude-usage-a',
    'D:\\Users\\me\\.claude-usage-a',
    '\\\\server\\share\\.claude-usage-a',
    '\\\\?\\C:\\Users\\me\\.claude-usage-a\\..\\..\\x',
    'C:\\Users\\me\\.claude-usage-a.',
    'C:\\Users\\me\\.claude-usage-a ',
    'C:\\Users\\me.\\.claude-usage-a',
  ]) {
    assert.equal(isUsageDirFor(bad, home, 'a'), false, bad);
  }
});

test('sanitize keeps a good usageDir and drops a bad one without dropping the account', () => {
  const s = sanitize({
    accounts: [
      { id: 'a', label: 'A', token: setupToken('a'), usageDir: path.join(HOME, '.claude-usage-a'), usageEmail: 'a@b.pl' },
      { id: 'b', label: 'B', token: setupToken('b'), usageDir: path.resolve(HOME, '..', 'x'), usageEmail: 'b@b.pl' },
      { id: 'c', label: 'C', token: setupToken('c'), usageDir: path.join(HOME, '.claude-usage-c'), usageEmail: '<script>' },
    ],
  }, HOME);
  assert.deepEqual(s.accounts.map((a) => [a.id, a.usageDir || null, a.usageEmail || null]), [
    ['a', path.join(HOME, '.claude-usage-a'), 'a@b.pl'],
    ['b', null, null],
    ['c', path.join(HOME, '.claude-usage-c'), null],
  ]);
  assert.deepEqual(sanitize('garbage', HOME), { accounts: [], limits: {} });
});

const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

test('store: setUsage persists the dir, refuses one outside home, and list() never carries a path or token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-acct-usage-'));
  try {
    const file = path.join(dir, 'claude-accounts.local.json');
    const store = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, homeDir: () => HOME });
    const { id } = store.add('Onet', setupToken('o'));
    assert.deepEqual(store.setUsage(id, path.resolve(HOME, '..', 'evil')), { ok: false, error: 'badDir' });
    assert.deepEqual(store.setUsage('missing', dirOf('x')), { ok: false, error: 'notFound' });
    assert.deepEqual(store.setUsage(id, dirOf(id), 'o@onet.pl'), { ok: true });
    // A second instance reads it back from disk (host mode / restart).
    const again = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, homeDir: () => HOME });
    assert.deepEqual(again.usageTargets(), [{ id, label: 'Onet', active: true, usageDir: dirOf(id), usageEmail: 'o@onet.pl' }]);
    const listed = JSON.stringify(again.list());
    assert.ok(!listed.includes('usageDir') && !listed.includes(setupToken('o')));
    assert.deepEqual(again.setUsage(id, null), { ok: true });
    assert.equal(again.usageTargets()[0].usageDir, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a corrupt file yields an empty list rather than a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-acct-bad-'));
  try {
    const file = path.join(dir, 'claude-accounts.local.json');
    fs.writeFileSync(file, '{broken');
    const store = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, homeDir: () => HOME });
    assert.deepEqual(store.usageTargets(), []);
    assert.deepEqual(store.list().accounts, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- IPC (src/claudeaccountsipc.js) --------------------------------------

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) } };
}

test('IPC: the usage handlers validate the id in main and forward only a valid one', async () => {
  const seen = [];
  const accountUsage = {
    decorate: (v) => ({ ...v, decorated: true }),
    connect: async (id) => { seen.push(['connect', id]); return { ok: true, email: null }; },
    useMain: (id) => { seen.push(['main', id]); return { ok: true }; },
    disconnect: (id) => { seen.push(['off', id]); return { ok: true }; },
  };
  const { handlers, ipcMain } = fakeIpc();
  registerClaudeAccountsIpc({ ipcMain, accounts: { list: () => ({ accounts: [] }) }, openTokenTab: () => {}, accountUsage });
  for (const bad of ['../x', 'A', '', null, 42, { id: 'a' }, 'a'.repeat(21)]) {
    assert.deepEqual(await handlers.get('claudeAccounts:connect-usage')({}, bad), { ok: false, error: 'notFound' });
    assert.deepEqual(handlers.get('claudeAccounts:use-main-usage')({}, bad), { ok: false, error: 'notFound' });
    assert.deepEqual(handlers.get('claudeAccounts:disconnect-usage')({}, bad), { ok: false, error: 'notFound' });
  }
  assert.deepEqual(seen, []);
  await handlers.get('claudeAccounts:connect-usage')({}, 'onet');
  handlers.get('claudeAccounts:use-main-usage')({}, 'gmail');
  handlers.get('claudeAccounts:disconnect-usage')({}, 'onet');
  assert.deepEqual(seen, [['connect', 'onet'], ['main', 'gmail'], ['off', 'onet']]);
  assert.equal(handlers.get('claudeAccounts:list')().decorated, true);
});

test('IPC: without a usage reader the old handlers stay as they were', () => {
  const { handlers, ipcMain } = fakeIpc();
  registerClaudeAccountsIpc({ ipcMain, accounts: { list: () => ({ accounts: [] }) }, openTokenTab: () => {} });
  assert.equal(handlers.has('claudeAccounts:connect-usage'), false);
  assert.deepEqual(handlers.get('claudeAccounts:list')(), { accounts: [] });
});

test('IPC: rename validates id and label in main before the store sees them', () => {
  const seen = [];
  const accounts = { list: () => ({ accounts: [] }), rename: (id, label) => { seen.push([id, label]); return { ok: true }; } };
  const { handlers, ipcMain } = fakeIpc();
  registerClaudeAccountsIpc({ ipcMain, accounts, openTokenTab: () => {} });
  const rename = handlers.get('claudeAccounts:rename');
  for (const bad of [null, 'gmail', 42, { id: '../x', label: 'a' }, { id: 'A', label: 'a' }]) {
    assert.deepEqual(rename({}, bad), { ok: false, error: 'notFound' });
  }
  for (const label of [undefined, 42, {}, 'x'.repeat(201)]) {
    assert.deepEqual(rename({}, { id: 'gmail', label }), { ok: false, error: 'badLabel' });
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(rename({}, { id: 'gmail', label: 'gmail' }), { ok: true });
  assert.deepEqual(seen, [['gmail', 'gmail']]);
});

// ---- watcher hook --------------------------------------------------------

test('watcher: refresh forces the account pass; no reader -> no accounts field', async () => {
  const forced = [];
  const payloads = [];
  const watcher = new UsageWatcher((u) => payloads.push(u));
  watcher.fetchPrimary = async () => ({ providerId: 'claude', status: 'ok', limits: [], updatedAt: NOW });
  watcher.readOthers = async () => [];
  await watcher.tick();
  assert.equal('accounts' in payloads[0], false);
  watcher.accountUsage = { read: async ({ force }) => { forced.push(force); return []; } };
  await watcher.tick();
  await watcher.refresh();
  watcher.stop();
  assert.deepEqual(forced, [false, true]);
  // A throwing reader never breaks the tick.
  watcher.accountUsage = { read: async () => { throw new Error('boom'); } };
  await watcher.tick();
  watcher.stop();
  assert.deepEqual(payloads.at(-1).accounts, []);
});
