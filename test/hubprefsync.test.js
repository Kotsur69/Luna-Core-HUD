// ============================================================================
// LunaCore - notification hub N7: Settings + seen marks synced across PCs
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N7.
//   - src/hubprefsync.js: the configsync.js provider for hub:pref:* units -
//     read / write / owns, newest wins between two PCs (through the real
//     createConfigSync), a fresh PC's defaults never overwrite a real choice,
//     untrusted cloud values are rejected by valid();
//   - src/hubdone.js: hub:seen:* units (30-day prune, 500 cap);
//   - the provider's write() is a writeUiPrefs() partial merge (the real
//     uiprefs.js against a temp dir - never config/ui.local.json).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../src/hubprefsync.js');
const { createConfigSync } = require('../src/configsync.js');
const { createDoneStore, createHubSeenProvider, createHubDoneProvider, MAX_DONE_KEPT, DONE_KEEP_MS } = require('../src/hubdone.js');
const paths = require('../src/paths.js');
const uiprefs = require('../src/uiprefs.js');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DEFAULTS = Object.freeze({ hubAutoOpen: 'needed', hubToasts: true, hubSources: {}, notificationsEnabled: false, hubWidth: 420, theme: 'luna' });

function tmpDir(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `luna-hubprefsync-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** One PC: an in-memory ui prefs store, its ui.local.json mtime, and a configsync over the provider. */
function pc(t, tag, { prefs = {}, fileAt = null } = {}) {
  const dir = tmpDir(t, tag);
  let stored = { ...DEFAULTS, ...prefs };
  const uiFile = path.join(dir, 'ui.local.json');
  if (fileAt !== null) {
    fs.writeFileSync(uiFile, '{}\n');
    fs.utimesSync(uiFile, new Date(fileAt), new Date(fileAt));
  }
  const provider = ps.createHubPrefsProvider({
    readPrefs: () => ({ ...stored }),
    writePrefs: (partial) => (stored = { ...stored, ...partial }),
    file: () => (fileAt === null ? null : uiFile),
  });
  let clock = NOW;
  let peers = [];
  let published = { units: [], gone: {} };
  const sync = createConfigSync({
    providers: [provider],
    metaFile: path.join(dir, 'config-sync.local.json'),
    now: () => clock,
    extraPeers: () => peers,
    onPublish: (doc) => (published = doc),
  });
  return {
    provider,
    get prefs() {
      return stored;
    },
    set(partial) {
      stored = { ...stored, ...partial };
    },
    /** One sync at `at` against the other PCs' last published docs. */
    syncWith(at, ...others) {
      clock = at;
      peers = others.map((o) => o.published);
      return sync.syncOnce();
    },
    get published() {
      return published;
    },
  };
}

// --- provider contract ---------------------------------------------------------

test('read(): the four synced prefs as units, sorted, and nothing else', () => {
  const p = ps.createHubPrefsProvider({ readPrefs: () => ({ ...DEFAULTS, hubAutoOpen: 'always', hubSources: { life: false } }), writePrefs: () => ({}) });
  const { units, base } = p.read(NOW);
  assert.deepEqual(units, [
    ['hub:pref:autoOpen', { value: 'always' }],
    ['hub:pref:notify', { value: false }],
    ['hub:pref:sources', { value: { life: false } }],
    ['hub:pref:toasts', { value: true }],
  ]);
  assert.equal(base, 0, 'no file: nothing was chosen here');
  // configsync.js firstSyncDefaults() reads isDefault from the read() result.
  assert.equal(typeof p.read(NOW).isDefault, 'function');
  assert.equal(p.name, 'hubprefs');
  assert.ok(p.owns('hub:pref:toasts') && !p.owns('hub:done:x') && !p.owns('hub:seen:x') && !p.owns(42));
  // hubWidth and hubBriefHintSeen stay local.
  assert.deepEqual([...ps.SYNCED_PREFS].sort(), ['hubAutoOpen', 'hubSources', 'hubToasts', 'notificationsEnabled']);
});

test('read(): a broken stored value goes out as the default, never as garbage', () => {
  const p = ps.createHubPrefsProvider({ readPrefs: () => ({ hubAutoOpen: 'sometimes', hubToasts: 'yes', hubSources: [1], notificationsEnabled: null }), writePrefs: () => ({}) });
  const values = Object.fromEntries(p.read(NOW).units.map(([k, v]) => [k, v.value]));
  assert.deepEqual(values, { 'hub:pref:autoOpen': 'needed', 'hub:pref:notify': false, 'hub:pref:sources': {}, 'hub:pref:toasts': true });
  const nothing = ps.createHubPrefsProvider({ readPrefs: () => null, writePrefs: () => ({}) });
  assert.equal(nothing.read(NOW).units.length, 4);
});

test('read(): base = the ui.local.json mtime (capped at now)', (t) => {
  const dir = tmpDir(t, 'base');
  const f = path.join(dir, 'ui.local.json');
  fs.writeFileSync(f, '{}\n');
  fs.utimesSync(f, new Date(NOW - DAY), new Date(NOW - DAY));
  const p = ps.createHubPrefsProvider({ readPrefs: () => DEFAULTS, writePrefs: () => ({}), file: () => f });
  assert.ok(Math.abs(p.read(NOW).base - (NOW - DAY)) < 1000);
  assert.equal(p.read(NOW - 2 * DAY).base, NOW - 2 * DAY, 'never in the future');
});

test('valid(): untrusted cloud values are rejected, not turned into defaults', () => {
  const v = ps.validPref;
  assert.deepEqual(v('hub:pref:autoOpen', { value: 'always' }), { value: 'always' });
  assert.deepEqual(v('hub:pref:toasts', { value: false }), { value: false });
  assert.deepEqual(v('hub:pref:notify', { value: true }), { value: true });
  assert.deepEqual(v('hub:pref:sources', { value: { life: false, mail: false } }), { value: { life: false, mail: false } });
  // A newer PC may know a group this one does not: dropped quietly.
  assert.deepEqual(v('hub:pref:sources', { value: { life: false, someday: false } }), { value: { life: false } });
  const bad = [
    ['hub:pref:autoOpen', { value: 'sometimes' }],
    ['hub:pref:autoOpen', { value: 1 }],
    ['hub:pref:autoOpen', {}],
    ['hub:pref:autoOpen', 'always'],
    ['hub:pref:toasts', { value: 'yes' }],
    ['hub:pref:toasts', { value: null }],
    ['hub:pref:notify', { value: 1 }],
    ['hub:pref:sources', { value: { life: true } }],
    ['hub:pref:sources', { value: [false] }],
    ['hub:pref:sources', { value: 'life' }],
    ['hub:pref:width', { value: 500 }],
    ['hub:pref:__proto__', { value: true }],
    ['hub:pref:constructor', { value: true }],
    ['hub:done:x', { value: true }],
    [null, { value: true }],
  ];
  for (const [k, val] of bad) assert.equal(v(k, val), null, `${String(k)} ${JSON.stringify(val)}`);
});

test('isDefault(): only an untouched default is low-stamped on a first sync', () => {
  const p = ps.createHubPrefsProvider({ readPrefs: () => DEFAULTS, writePrefs: () => ({}) });
  assert.equal(p.isDefault('hub:pref:autoOpen', { value: 'needed' }), true);
  assert.equal(p.isDefault('hub:pref:toasts', { value: true }), true);
  assert.equal(p.isDefault('hub:pref:sources', { value: {} }), true);
  assert.equal(p.isDefault('hub:pref:notify', { value: false }), true);
  assert.equal(p.isDefault('hub:pref:autoOpen', { value: 'never' }), false);
  assert.equal(p.isDefault('hub:pref:sources', { value: { life: false } }), false);
  assert.equal(p.isDefault('hub:pref:notify', { value: true }), false);
  assert.equal(p.isDefault('hub:pref:other', { value: true }), false);
});

test('write(): one partial merge of the valid units; a tombstone leaves the pref alone', () => {
  const writes = [];
  const p = ps.createHubPrefsProvider({ readPrefs: () => DEFAULTS, writePrefs: (partial) => (writes.push(partial), { ...DEFAULTS, ...partial }) });
  p.write([
    ['hub:pref:autoOpen', { value: 'never' }],
    ['hub:pref:toasts', { value: 'garbage' }],
    ['hub:pref:sources', { value: { mail: false } }],
  ]);
  assert.deepEqual(writes, [{ hubAutoOpen: 'never', hubSources: { mail: false } }]);
  p.write([]);
  assert.equal(writes.length, 1, 'nothing to write, no write');
  const failing = ps.createHubPrefsProvider({ readPrefs: () => DEFAULTS, writePrefs: () => null });
  assert.throws(() => failing.write([['hub:pref:toasts', { value: false }]]), /not written/, 'configsync skips the round');
});

test('touchesSyncedPrefs(): a ui:set of a synced pref asks for a sync, hubWidth does not', () => {
  assert.equal(ps.touchesSyncedPrefs({ hubToasts: false }), true);
  assert.equal(ps.touchesSyncedPrefs({ notificationsEnabled: true }), true);
  assert.equal(ps.touchesSyncedPrefs({ hubWidth: 500 }), false);
  assert.equal(ps.touchesSyncedPrefs({ hubBriefHintSeen: true }), false);
  for (const bad of [null, undefined, 'hubToasts', ['hubToasts']]) assert.equal(ps.touchesSyncedPrefs(bad), false);
});

// --- two PCs through the real configsync --------------------------------------

test('a fresh PC takes the real choice and never overwrites it with its defaults', (t) => {
  // PC A chose "always" and turned the Life source off two days ago.
  const a = pc(t, 'a', { prefs: { hubAutoOpen: 'always', hubSources: { life: false } }, fileAt: NOW - 2 * DAY });
  a.syncWith(NOW - DAY);
  // PC B is new: its ui.local.json was written just now (a theme pick), hub prefs untouched.
  const b = pc(t, 'b', { prefs: { theme: 'void' }, fileAt: NOW - MIN });
  assert.deepEqual(b.syncWith(NOW, a), ['hubprefs']);
  assert.equal(b.prefs.hubAutoOpen, 'always');
  assert.deepEqual(b.prefs.hubSources, { life: false });
  assert.equal(b.prefs.theme, 'void', 'other prefs untouched');
  // A syncs again with B's publish: A keeps its choice.
  a.syncWith(NOW + MIN, b);
  assert.equal(a.prefs.hubAutoOpen, 'always');
  assert.deepEqual(a.prefs.hubSources, { life: false });
});

test('newest change wins, in both directions; hubWidth never travels', (t) => {
  const a = pc(t, 'a', { prefs: { hubWidth: 600 }, fileAt: NOW - DAY });
  const b = pc(t, 'b', { prefs: { hubWidth: 360 }, fileAt: NOW - DAY });
  a.syncWith(NOW);
  b.syncWith(NOW, a);
  a.syncWith(NOW + MIN, b);

  // B switches toasts off: A follows.
  b.set({ hubToasts: false });
  b.syncWith(NOW + 2 * MIN, a);
  assert.deepEqual(a.syncWith(NOW + 3 * MIN, b), ['hubprefs']);
  assert.equal(a.prefs.hubToasts, false);

  // A turns notifications on and picks "never"; B follows, then B goes back to "needed" later.
  a.set({ notificationsEnabled: true, hubAutoOpen: 'never' });
  a.syncWith(NOW + 4 * MIN, b);
  b.syncWith(NOW + 5 * MIN, a);
  assert.equal(b.prefs.notificationsEnabled, true);
  assert.equal(b.prefs.hubAutoOpen, 'never');
  b.set({ hubAutoOpen: 'needed' });
  b.syncWith(NOW + 6 * MIN, a);
  a.syncWith(NOW + 7 * MIN, b);
  assert.equal(a.prefs.hubAutoOpen, 'needed', 'a later change back to the default still wins');

  assert.equal(a.prefs.hubWidth, 600);
  assert.equal(b.prefs.hubWidth, 360);
  assert.deepEqual(a.published.units.map((u) => u.k).sort(), ['hub:pref:autoOpen', 'hub:pref:notify', 'hub:pref:sources', 'hub:pref:toasts']);
  assert.ok(a.published.units.every((u) => Object.keys(u.v).join() === 'value' && u.v.value !== 600), 'hubWidth never travels');
});

test('a peer row with a bad value never overwrites the local choice', (t) => {
  const a = pc(t, 'a', { prefs: { hubAutoOpen: 'always' }, fileAt: NOW - DAY });
  a.syncWith(NOW);
  const evil = {
    published: {
      units: [
        { k: 'hub:pref:autoOpen', v: { value: 'rm -rf' }, u: NOW + MIN },
        { k: 'hub:pref:toasts', v: { value: 'off' }, u: NOW + MIN },
        { k: 'hub:pref:sources', v: { value: { life: true } }, u: NOW + MIN },
        { k: 'hub:pref:hubWidth', v: { value: 9999 }, u: NOW + MIN },
      ],
      gone: {},
    },
  };
  assert.deepEqual(a.syncWith(NOW + 2 * MIN, evil), []);
  assert.equal(a.prefs.hubAutoOpen, 'always');
  assert.equal(a.prefs.hubToasts, true);
  assert.deepEqual(a.prefs.hubSources, {});
  assert.equal(a.prefs.hubWidth, 420);
});

// --- seen marks (hub:seen:<id>) ----------------------------------------------

test('seen marks sync as hub:seen units, apart from the done marks', (t) => {
  const dir = tmpDir(t, 'seen');
  const store = createDoneStore({ file: () => path.join(dir, 'hub-seen.local.json'), now: () => NOW });
  store.mark('godmode:p1abc');
  const p = createHubSeenProvider(store, { now: () => NOW });
  assert.equal(p.name, 'hubseen');
  assert.deepEqual(p.read().units, [['hub:seen:godmode:p1abc', { at: NOW }]]);
  assert.ok(p.owns('hub:seen:x') && !p.owns('hub:done:x'));
  assert.ok(!createHubDoneProvider(store, { now: () => NOW }).owns('hub:seen:x'), 'the done provider leaves them alone');
  assert.deepEqual(p.valid('hub:seen:life:checkin:2026-11-08', { at: NOW - DAY }), { at: NOW - DAY });
  for (const [k, v] of [
    ['hub:seen:life:checkin:x', { at: NOW - DONE_KEEP_MS - DAY }],
    ['hub:seen:life:checkin:x', { at: 'yesterday' }],
    ['hub:seen:life:checkin:x', { at: NOW + 2 * DAY }],
    ['hub:seen:NOT AN ID', { at: NOW }],
    ['hub:done:life:checkin:x', { at: NOW }],
  ]) {
    assert.equal(p.valid(k, v), null, `${k} ${JSON.stringify(v)}`);
  }
});

test('seen marks: pruned after 30 days and capped at 500', (t) => {
  const dir = tmpDir(t, 'seencap');
  let clock = NOW;
  const store = createDoneStore({ file: () => path.join(dir, 'hub-seen.local.json'), now: () => clock });
  const p = createHubSeenProvider(store, { now: () => clock });
  const units = Array.from({ length: MAX_DONE_KEPT + 100 }, (_, i) => [`hub:seen:life:item:${String(i).padStart(4, '0')}`, { at: NOW - i * MIN }]);
  p.write(units);
  const kept = p.read().units;
  assert.equal(kept.length, MAX_DONE_KEPT, 'capped');
  assert.ok(kept.some(([k]) => k === 'hub:seen:life:item:0000'), 'the newest are kept');
  assert.ok(!kept.some(([k]) => k === `hub:seen:life:item:${String(MAX_DONE_KEPT + 99).padStart(4, '0')}`), 'the oldest go');
  // 31 days later every mark is past the window: the units leave (a tombstone).
  clock = NOW + DONE_KEEP_MS + DAY;
  assert.deepEqual(p.read().units, []);
});

// --- the real writeUiPrefs partial merge --------------------------------------

test('write() through the real writeUiPrefs keeps every other pref', (t) => {
  const dir = tmpDir(t, 'ui');
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(() => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
  });

  assert.ok(uiprefs.writeUiPrefs({ theme: 'void', hubWidth: 512, hubBriefHintSeen: true, hubAutoOpen: 'always' }));
  const p = ps.createHubPrefsProvider({ readPrefs: uiprefs.readUiPrefs, writePrefs: uiprefs.writeUiPrefs, file: () => paths.local('ui.local.json') });
  p.write([
    ['hub:pref:toasts', { value: false }],
    ['hub:pref:sources', { value: { life: false } }],
    ['hub:pref:notify', { value: true }],
  ]);
  const after = uiprefs.readUiPrefs();
  assert.equal(after.hubToasts, false);
  assert.deepEqual(after.hubSources, { life: false });
  assert.equal(after.notificationsEnabled, true);
  assert.equal(after.hubAutoOpen, 'always', 'a pref not in the units is kept');
  assert.equal(after.theme, 'void');
  assert.equal(after.hubWidth, 512, 'hubWidth stays local');
  assert.equal(after.hubBriefHintSeen, true);
  // And read() sees the merged file.
  const values = Object.fromEntries(p.read(Date.now()).units.map(([k, v]) => [k, v.value]));
  assert.deepEqual(values, { 'hub:pref:autoOpen': 'always', 'hub:pref:notify': true, 'hub:pref:sources': { life: false }, 'hub:pref:toasts': false });
  assert.ok(p.read(Date.now()).base > 0, 'the file exists: a real choice');
});
