'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const probes = require('../src/setupprobes');
const { registerSetupIpc, linkFor } = require('../src/setupipc');

const URL_A = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const URL_B = 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co';
const KEY = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_123';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'luna-setup-'));

/** Minimal ipcMain double: records handlers, lets the test call them. */
function fakeIpc() {
  const handlers = {};
  const listeners = {};
  return {
    handle: (ch, fn) => (handlers[ch] = fn),
    on: (ch, fn) => (listeners[ch] = fn),
    invoke: (ch, arg) => handlers[ch]({}, arg),
    send: (ch, arg) => listeners[ch]({}, arg),
  };
}

function setup({ probeSet = {}, cloud = null, now = () => 1_000_000, confirmReplace } = {}) {
  const dir = tmpDir();
  let prefs = { welcomeSeen: null, welcomeChecked: false, pwaUrl: null };
  const opened = [];
  const ipc = fakeIpc();
  registerSetupIpc({
    ipcMain: ipc,
    shell: { openExternal: (u) => opened.push(u) },
    app: { getVersion: () => '0.17.0', relaunch: () => opened.push('relaunch'), quit: () => opened.push('quit') },
    cloud: () => cloud,
    gcal: { status: () => ({ configured: false, connected: false }) },
    claudeFound: () => true,
    confirmReplace,
    deps: {
      probes: probeSet,
      now,
      hadLocalConfig: false,
      cloudFile: () => path.join(dir, 'cloud.local.json'),
      sessionFile: () => path.join(dir, 'cloud-session.local.json'),
      readPrefs: () => prefs,
      writePrefs: (p) => (prefs = { ...prefs, ...p }),
    },
  });
  return { dir, ipc, opened, prefs: () => prefs, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- cloud.local.json writer ----------------------------------------------

test('writeCloudConfig writes only url + key, refuses to repoint without replace', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cloud.local.json');
  const sessionFile = path.join(dir, 'cloud-session.local.json');
  try {
    assert.deepEqual(probes.writeCloudConfig({ url: URL_A, publishableKey: KEY, extra: 'x' }, { file, sessionFile }), {
      ok: true,
      changedProject: false,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { url: URL_A, publishableKey: KEY });
    assert.equal(fs.existsSync(`${file}.tmp`), false);

    fs.writeFileSync(sessionFile, '{"v":1}');
    assert.deepEqual(probes.writeCloudConfig({ url: URL_B, publishableKey: KEY }, { file, sessionFile }), { ok: false, reason: 'exists' });
    assert.equal(probes.readCloudConfig(file).url, URL_A, 'old project kept');
    assert.equal(fs.existsSync(sessionFile), true);

    assert.deepEqual(probes.writeCloudConfig({ url: URL_B, publishableKey: KEY }, { file, sessionFile, replace: true }), {
      ok: true,
      changedProject: true,
    });
    assert.equal(probes.readCloudConfig(file).url, URL_B);
    assert.equal(fs.existsSync(sessionFile), false, "the old project's session is dropped");

    // Same project again (a rotated key): no confirmation needed.
    assert.equal(probes.writeCloudConfig({ url: URL_B, publishableKey: `${KEY}x` }, { file, sessionFile }).ok, true);
    assert.deepEqual(probes.writeCloudConfig({ url: 'https://evil.com', publishableKey: KEY }, { file, sessionFile }), {
      ok: false,
      reason: 'invalid',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- probes ----------------------------------------------------------------

test('ghAuthStatus maps exit / ENOENT / failure', async () => {
  const run = (err) => (_f, args, _o, cb) => {
    assert.deepEqual(args, ['auth', 'status']);
    cb(err);
  };
  assert.equal(await probes.ghAuthStatus({ run: run(null) }), 'ok');
  assert.equal(await probes.ghAuthStatus({ run: run(Object.assign(new Error('x'), { code: 'ENOENT' })) }), 'missing');
  assert.equal(await probes.ghAuthStatus({ run: run(Object.assign(new Error('x'), { code: 1 })) }), 'not-logged-in');
});

test('claudeLoggedIn: presence checks only', () => {
  const home = tmpDir();
  try {
    const env = {};
    assert.equal(probes.claudeLoggedIn({ env, home }), false);
    assert.equal(probes.claudeLoggedIn({ env: { ANTHROPIC_API_KEY: 'k' }, home }), true);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x' } }));
    assert.equal(probes.claudeLoggedIn({ env, home }), true);
    fs.rmSync(path.join(home, '.claude.json'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    assert.equal(probes.claudeLoggedIn({ env, home }), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probeTables / probeAuth / probeFunctions with a mocked fetch', async () => {
  const config = { url: URL_A, publishableKey: KEY };
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    if (url.includes('/rest/v1/push_sent')) return { status: 404, ok: false };
    if (url.includes('/rest/v1/host_events')) throw new Error('network');
    if (url.endsWith('/auth/v1/settings')) return { status: 200, ok: true, json: async () => ({ external: { github: true, google: false } }) };
    if (url.endsWith('/functions/v1/push')) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => [] };
  };
  const tables = await probes.probeTables(config, { fetchImpl });
  assert.equal(tables.present, 5);
  assert.deepEqual(tables.missing.sort(), ['host_events', 'push_sent']);
  assert.ok(seen.every((s) => s.url.startsWith(`${URL_A}/`)), 'only the configured project is contacted');
  assert.ok(seen.every((s) => s.opts.redirect === 'error'));
  assert.deepEqual(await probes.probeAuth(config, { fetchImpl }), { github: true, google: false });
  assert.deepEqual(await probes.probeFunctions(config, { fetchImpl }), { google: 'deployed', push: 'missing' });
});

// ---- IPC -------------------------------------------------------------------

test('setup:save-cloud validates in main; a project swap needs the main-side confirmation', async () => {
  let answer = false;
  let asked = 0;
  const s = setup({ confirmReplace: async () => (asked++, answer) });
  try {
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', { url: 'https://evil.com', key: KEY }), { ok: false, reason: 'bad-url' });
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', { url: URL_A, key: 'sb_secret_abcdefghijklmnopqrstuv' }), {
      ok: false,
      reason: 'secret-key',
    });
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', 'garbage'), { ok: false, reason: 'bad-url' });
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', { url: URL_A, key: KEY }), { ok: true, changedProject: false });
    // The renderer cannot approve the swap by itself: replace:true is ignored.
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', { url: URL_B, key: KEY, replace: true }), { ok: false, reason: 'cancelled' });
    assert.equal(asked, 1);
    assert.equal(probes.readCloudConfig(path.join(s.dir, 'cloud.local.json')).url, URL_A);
    answer = true;
    assert.deepEqual(await s.ipc.invoke('setup:save-cloud', { url: URL_B, key: KEY }), { ok: true, changedProject: true });
    assert.equal(probes.readCloudConfig(path.join(s.dir, 'cloud.local.json')).url, URL_B);
  } finally {
    s.done();
  }
});

test('setup:status returns states only, cached briefly', async () => {
  let calls = 0;
  let t = 1_000_000;
  const s = setup({
    now: () => t,
    probeSet: {
      claude: () => {
        calls++;
        return { installed: true, loggedIn: true, token: 'sk-ant-secret' };
      },
      gh: () => 'ok',
    },
    cloud: { status: () => ({ configured: true, loggedIn: true }), userId: () => '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
  });
  try {
    const st = await s.ipc.invoke('setup:status');
    assert.equal(st.ok, true);
    assert.equal(st.ownerUserId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    assert.equal(JSON.stringify(st).includes('sk-ant-secret'), false, 'probe extras never cross IPC');
    assert.equal(st.rows.find((r) => r.id === 'claude').state, 'ok');
    await s.ipc.invoke('setup:status');
    assert.equal(calls, 1, 'second call inside the TTL is served from cache');
    t += 5000;
    await s.ipc.invoke('setup:status');
    assert.equal(calls, 2);
  } finally {
    s.done();
  }
});

test('setup:check-tables needs a config', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.ipc.invoke('setup:check-tables'), { ok: false, reason: 'not-configured' });
  } finally {
    s.done();
  }
});

test('setup:set-pwa-url + setup:pwa-qr', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.ipc.invoke('setup:pwa-qr'), { ok: false, reason: 'no-url' });
    assert.deepEqual(await s.ipc.invoke('setup:set-pwa-url', 'http://insecure.app'), { ok: false, reason: 'bad-url' });
    assert.deepEqual(await s.ipc.invoke('setup:set-pwa-url', 'https://luna.vercel.app'), { ok: true, pwaUrl: 'https://luna.vercel.app/' });
    const qr = await s.ipc.invoke('setup:pwa-qr');
    assert.equal(qr.ok, true);
    assert.equal(qr.bits.length, qr.size * qr.size);
    assert.deepEqual(await s.ipc.invoke('setup:set-pwa-url', null), { ok: true, pwaUrl: null });
  } finally {
    s.done();
  }
});

test('setup:open only opens whitelisted targets; relaunch is rate-limited', () => {
  const s = setup();
  try {
    s.ipc.send('setup:open', 'gh-install');
    s.ipc.send('setup:open', 'https://evil.com');
    s.ipc.send('setup:open', 'supabase-sql'); // no project yet -> nothing
    s.ipc.send('setup:open', '__proto__');
    assert.deepEqual(s.opened, ['https://cli.github.com/']);
    s.ipc.send('setup:relaunch');
    s.ipc.send('setup:relaunch');
    assert.deepEqual(s.opened.slice(1), ['relaunch', 'quit']);
  } finally {
    s.done();
  }
});

test('linkFor builds project pages from the validated config only', () => {
  const cfg = () => ({ url: URL_A });
  assert.equal(linkFor('supabase-sql', cfg, () => null), 'https://supabase.com/dashboard/project/aaaaaaaaaaaaaaaaaaaa/sql/new');
  assert.equal(linkFor('supabase-sql', () => ({ url: 'https://evil.com' }), () => null), null);
  assert.equal(linkFor('pwa', cfg, () => 'https://luna.vercel.app/'), 'https://luna.vercel.app/');
  assert.equal(linkFor(42, cfg, () => null), null);
  assert.equal(linkFor('constructor', cfg, () => null), null);
});

test('welcome:get / welcome:dismiss', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.ipc.invoke('welcome:get'), { show: true });
    assert.equal(s.prefs().welcomeChecked, true);
    await s.ipc.invoke('welcome:dismiss', { dontShow: false });
    assert.equal(s.prefs().welcomeSeen, null);
    await s.ipc.invoke('welcome:dismiss', { dontShow: true });
    assert.equal(s.prefs().welcomeSeen, '0.17.0');
    await s.ipc.invoke('welcome:dismiss', 'junk');
    assert.equal(s.prefs().welcomeSeen, '0.17.0');
  } finally {
    s.done();
  }
});
