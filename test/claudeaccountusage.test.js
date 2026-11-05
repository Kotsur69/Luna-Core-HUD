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

const credFile = (token, expiresAt = NOW + 8 * 60 * MIN) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

/**
 * A fake world: files by path, targets as the store would list them, a GET
 * answering per token, an execFile recording every CLI call.
 */
function world({ targets, files = {}, answers = {}, cli = {} } = {}) {
  const fileMap = new Map(Object.entries(files));
  const calls = { fetch: [], exec: [], sleep: [], setUsage: [], connected: 0 };
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
  });
  const entries = await w.usage.read();
  assert.deepEqual(entries.map((e) => e.status), ['ok', 'reconnect', 'reconnect']);
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

test('renewal runs `claude auth status` near expiry under the usage dir, then re-reads the file', async () => {
  const old = fakeToken('old');
  const fresh = fakeToken('fresh');
  const dir = dirOf('a');
  const w = world({
    targets: [{ id: 'a', label: 'A', active: true, usageDir: dir }],
    files: { [credPath(dir)]: credFile(old, NOW + 5 * MIN) },
    answers: { [old]: { status: 401, body: '' }, [fresh]: { status: 200, body: usageBody(7, 8) } },
    cli: {
      'auth status': (opts, files) => {
        files.set(path.join(opts.env.CLAUDE_CONFIG_DIR, '.credentials.json'), credFile(fresh, NOW + 8 * 60 * MIN));
        return { stdout: JSON.stringify({ loggedIn: true, email: 'a@example.com' }) };
      },
    },
  });
  const [entry] = await w.usage.read();
  assert.equal(entry.status, 'ok');
  assert.deepEqual(w.calls.fetch, [fresh]);
  assert.equal(w.calls.exec.length, 1);
  const call = w.calls.exec[0];
  assert.deepEqual(call.args, ['auth', 'status']);
  assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, dir);
  assert.equal(call.opts.shell, undefined, 'never through a shell');
  assert.equal(call.opts.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the setup token must not steer the usage login');
});

test('renewal never touches the main ~/.claude login, and is not retried in a loop', async () => {
  const tMain = fakeToken('main');
  const tA = fakeToken('a');
  const w = world({
    targets: [
      { id: 'm', label: 'M', active: true, usageDir: MAIN_DIR },
      { id: 'a', label: 'A', active: false, usageDir: dirOf('a') },
    ],
    files: { [credPath(MAIN_DIR)]: credFile(tMain, NOW + MIN), [credPath(dirOf('a'))]: credFile(tA, NOW + MIN) },
    answers: { [tMain]: { status: 200, body: usageBody(1, 1) }, [tA]: { status: 200, body: usageBody(1, 1) } },
  });
  await w.usage.read();
  for (const c of w.calls.exec) assert.notEqual(path.resolve(c.opts.env.CLAUDE_CONFIG_DIR), path.resolve(MAIN_DIR));
  assert.equal(w.calls.exec.length, 1, 'only the usage login is renewed');
  w.clock.now += 2 * MIN;
  await w.usage.read({ force: true });
  assert.equal(w.calls.exec.length, 1, 'one renewal attempt per retry window');
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
