// Account auto-reload: a switched or re-logged Claude account must reach the
// HUD without restarting LunaCore.
//
// Why this file matters: each of these paths used to drop the change on the
// floor - a refresh asked for while a usage read was in flight, a usage slot
// the in-flight pass wrote back after a reconnect dropped it, and a store
// written by another process - so the tile kept the old account until the
// next 90 s tick, or longer under 429 backoff.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccountUsage, usageDirFor } = require('../src/claudeaccountusage');
const { createClaudeAccounts } = require('../src/claudeaccounts');
const { UsageWatcher } = require('../src/usage');

const HOME = path.resolve(os.tmpdir(), 'lc-reload-home');
const MAIN_DIR = path.join(HOME, '.claude');
const NOW = Date.UTC(2026, 10, 12, 12);
const HOUR = 60 * 60 * 1000;

// Fake tokens are assembled at runtime, never written as one literal.
const fakeToken = (tag) => ['tok', 'reload', tag, 'x'.repeat(24)].join('-');
const setupToken = (c) => [['sk', 'ant', 'oat01'].join('-'), c.repeat(40)].join('-');

const credFile = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: NOW + 8 * HOUR } });
const usageBody = JSON.stringify({
  five_hour: { utilization: 10, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
  seven_day: { utilization: 20, resets_at: new Date(NOW + 72 * HOUR).toISOString() },
});
const credPath = (dir) => path.join(dir, '.credentials.json');

/** A promise plus its resolver, to hold a read open. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// ---- UsageWatcher.refresh while a tick is in flight ------------------------

test('watcher: a refresh asked for during an in-flight tick runs right after it', async () => {
  const payloads = [];
  const forced = [];
  const watcher = new UsageWatcher((u) => payloads.push(u));
  const hold = gate();
  let primaryReads = 0;
  watcher.fetchPrimary = async () => {
    primaryReads += 1;
    if (primaryReads === 1) await hold.promise;
    return { providerId: 'claude', status: 'ok', limits: [], updatedAt: NOW + primaryReads };
  };
  watcher.readOthers = async () => [];
  watcher.accountUsage = { read: async ({ force }) => { forced.push(force); return []; } };

  const first = watcher.tick(); // a regular read, still waiting on the network
  const refreshed = watcher.refresh(); // e.g. onConnected after a re-login
  hold.open();
  await first;
  await refreshed;
  watcher.stop();

  assert.equal(primaryReads, 2, 'the refresh was dropped instead of queued');
  // The account pass that started after the refresh is the forced one.
  assert.deepEqual(forced, [true, false]);
  assert.equal(payloads.length, 2);
});

test('watcher: a refresh during an in-flight account pass forces the follow-up pass', async () => {
  const forced = [];
  const watcher = new UsageWatcher(() => {});
  const hold = gate();
  watcher.fetchPrimary = async () => ({ providerId: 'claude', status: 'ok', limits: [], updatedAt: NOW });
  watcher.readOthers = async () => [];
  watcher.accountUsage = {
    read: async ({ force }) => {
      forced.push(force);
      if (forced.length === 1) await hold.promise;
      return [];
    },
  };
  const first = watcher.tick();
  await new Promise((resolve) => setImmediate(resolve)); // now inside the account pass
  const refreshed = watcher.refresh();
  hold.open();
  await first;
  await refreshed;
  watcher.stop();
  assert.deepEqual(forced, [false, true]);
});

test('watcher: several refreshes during one tick queue a single follow-up', async () => {
  const watcher = new UsageWatcher(() => {});
  const hold = gate();
  let primaryReads = 0;
  watcher.fetchPrimary = async () => {
    primaryReads += 1;
    if (primaryReads === 1) await hold.promise;
    return { providerId: 'claude', status: 'ok', limits: [], updatedAt: NOW };
  };
  watcher.readOthers = async () => [];
  const first = watcher.tick();
  watcher.refresh();
  watcher.refresh();
  watcher.refresh({ force: false });
  hold.open();
  await first;
  watcher.stop();
  assert.equal(primaryReads, 2);
});

test('watcher: refresh({force:false}) re-emits without forcing the account GETs', async () => {
  const forced = [];
  const payloads = [];
  const watcher = new UsageWatcher((u) => payloads.push(u));
  watcher.fetchPrimary = async () => ({ providerId: 'claude', status: 'error', limits: [], updatedAt: NOW });
  watcher.readOthers = async () => [];
  watcher.accountUsage = { read: async ({ force }) => { forced.push(force); return []; } };
  await watcher.tick();
  // An unchanged error is deduped by a plain tick, but a store change must
  // still repaint the tile (new label / active marker).
  await watcher.refresh({ force: false });
  watcher.stop();
  assert.deepEqual(forced, [false, false]);
  assert.equal(payloads.length, 2);
});

test('watcher: a failing account reader and a failing tick are logged, not swallowed', async () => {
  const logged = [];
  const watcher = new UsageWatcher(() => { throw new Error('render gone'); });
  watcher.log = (line) => logged.push(line);
  watcher.fetchPrimary = async () => ({ providerId: 'claude', status: 'ok', limits: [], updatedAt: NOW });
  watcher.readOthers = async () => [];
  watcher.accountUsage = { read: async () => { throw new Error('boom'); } };
  await watcher.tick(); // must not reject
  watcher.stop();
  assert.ok(logged.some((l) => l.includes('boom')), 'the account read error was swallowed');
  assert.ok(logged.some((l) => l.includes('render gone')), 'the tick error was swallowed');
});

// ---- account usage: a reconnect during an in-flight pass ------------------

test('usage: a login attached during an in-flight pass is read, not overwritten by the old slot', async () => {
  const tB = fakeToken('b');
  const tMain = fakeToken('main');
  const files = new Map([[credPath(usageDirFor(HOME, 'b')), credFile(tB)], [credPath(MAIN_DIR), credFile(tMain)]]);
  // 'a' has a usage dir with no credentials yet -> 'reconnect'.
  let list = [
    { id: 'a', label: 'A', active: true, usageDir: usageDirFor(HOME, 'a'), usageEmail: null },
    { id: 'b', label: 'B', active: false, usageDir: usageDirFor(HOME, 'b'), usageEmail: null },
  ];
  let hold = null;
  const fetched = [];
  const clock = { now: NOW };
  const usage = createAccountUsage({
    accounts: {
      usageTargets: () => list,
      setUsage: (id, dir, email) => {
        list = list.map((t) => (t.id === id ? { ...t, usageDir: dir, usageEmail: email } : t));
        return { ok: true };
      },
    },
    homeDir: () => HOME,
    readFile: (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    fetchUsage: async (token) => {
      fetched.push(token);
      if (token === tB && hold) await hold.promise;
      return { status: 200, body: usageBody, headers: {} };
    },
    claudeBin: () => null,
    now: () => clock.now,
    sleep: async () => {},
  });

  const pass1 = await usage.read();
  assert.equal(pass1[0].status, 'reconnect');

  // Pass 2: 'a' is re-read (still no login), then the pass waits on 'b'...
  clock.now += 90 * 1000;
  hold = gate();
  const pass2 = usage.read();
  await new Promise((resolve) => setImmediate(resolve));
  // ...while Mati points 'a' at the freshly /login-ed main ~/.claude.
  assert.deepEqual(usage.useMain('a'), { ok: true, email: null });
  hold.open();
  await pass2;

  // Settings must not keep showing the old 'reconnect' after a good login.
  const view = usage.decorate({ accounts: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(view.accounts[0].usage.status, 'loading');

  // The next regular (not forced) pass reads the new login right away.
  const pass3 = await usage.read();
  assert.equal(pass3[0].status, 'ok', 'the stale slot from before the reconnect came back');
  assert.ok(fetched.includes(tMain));
});

// ---- the store: a write from another process -------------------------------

/** A reversible stand-in for Electron's safeStorage. */
const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

function twoProcesses() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reload-'));
  const file = path.join(dir, 'claude-accounts.local.json');
  const changes = { hud: 0 };
  const writer = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, now: () => NOW });
  const hud = createClaudeAccounts({
    file: () => file,
    safeStorage: fakeStorage,
    now: () => NOW,
    onChange: () => { changes.hud += 1; },
  });
  /** Some filesystems round mtime to whole seconds - force a distinct one. */
  const bump = (s) => {
    const at = new Date(Date.now() + s * 1000);
    fs.utimesSync(file, at, at);
  };
  return { file, writer, hud, changes, bump };
}

test('store: a write by another process fires onChange once in this one', () => {
  const p = twoProcesses();
  assert.equal(p.hud.active(), null); // first look: nothing stored yet
  assert.equal(p.changes.hud, 0, 'the first load is not a change');
  p.writer.add('A', setupToken('a'));
  p.bump(5);
  assert.equal(p.hud.active().label, 'A');
  assert.equal(p.changes.hud, 1, 'the HUD was never told about the new account');
  p.hud.list();
  assert.equal(p.changes.hud, 1, 'an unchanged file is not a change');
  p.bump(10); // touched, same content
  p.hud.list();
  assert.equal(p.changes.hud, 1, 'a new mtime with the same accounts is not a change');
});

test('store: a store deleted by another process fires onChange', () => {
  const p = twoProcesses();
  p.writer.add('A', setupToken('a'));
  p.bump(5);
  assert.equal(p.hud.active().label, 'A');
  const before = p.changes.hud;
  fs.rmSync(p.file);
  assert.equal(p.hud.active(), null);
  assert.equal(p.changes.hud, before + 1);
});

test('store: the first load of an existing store is not a change', () => {
  const p = twoProcesses();
  p.writer.add('A', setupToken('a'));
  assert.equal(p.hud.active().label, 'A');
  assert.equal(p.changes.hud, 0);
});

test('store: a throwing onChange does not turn a good save into saveFailed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reload-'));
  const logged = [];
  const store = createClaudeAccounts({
    file: () => path.join(dir, 'claude-accounts.local.json'),
    safeStorage: fakeStorage,
    now: () => NOW,
    log: (line) => logged.push(line),
    onChange: () => { throw new Error('window gone'); },
  });
  const res = store.add('A', setupToken('a'));
  assert.equal(res.ok, true);
  assert.equal(store.list().accounts.length, 1);
  assert.ok(logged.some((l) => l.includes('window gone')));
});
