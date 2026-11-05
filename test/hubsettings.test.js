// ============================================================================
// LunaCore - Settings -> Notification hub (docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N6)
// ----------------------------------------------------------------------------
// - the stored prefs are validated (auto-open mode, toasts, source groups);
// - a switched-off source group is not even read by the hub, and turning it
//   back on brings its items back; a broken setting keeps every source on;
// - the renderer's switch list matches src/hubsources.js;
// - the Settings markup and its wiring are in place (static: the module runs
//   in Electron, not node);
// - every hubset.* key exists in pl and en.
// No test writes config/ui.local.json (the real one).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createHub } = require('../src/hub.js');
const { createDoneStore } = require('../src/hubdone.js');
const { HUB_SOURCE_GROUPS, GROUP_NAMES, cleanHubSources, isCollectorOn } = require('../src/hubsources.js');
const { cleanHubAutoOpen, readUiPrefs } = require('../src/uiprefs.js');
const { registerHubIpc } = require('../src/hubipc.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = 1_800_000_000_000;

test('stored prefs are validated', () => {
  for (const mode of ['always', 'needed', 'never']) assert.equal(cleanHubAutoOpen(mode), mode);
  for (const bad of [undefined, null, 'sometimes', 1, {}]) assert.equal(cleanHubAutoOpen(bad), 'needed', 'default: only when needed');
  assert.deepEqual(cleanHubSources({ life: false, mail: true, bogus: false, godmode: 'no' }), { life: false });
  for (const bad of [null, 'x', [false], 42]) assert.deepEqual(cleanHubSources(bad), {});
  const prefs = readUiPrefs();
  assert.ok(['always', 'needed', 'never'].includes(prefs.hubAutoOpen));
  assert.equal(typeof prefs.hubToasts, 'boolean');
  assert.equal(typeof prefs.hubSources, 'object');
});

test('every collector belongs to exactly one group', () => {
  const { COLLECTORS } = require('../src/hubcollect.js');
  const names = [...Object.keys(COLLECTORS), 'peers'];
  for (const name of names) {
    const owners = GROUP_NAMES.filter((g) => HUB_SOURCE_GROUPS[g].includes(name));
    assert.equal(owners.length, 1, `${name} is in ${owners.join(', ') || 'no group'}`);
  }
  assert.equal(isCollectorOn('checkin', { life: false }), false);
  assert.equal(isCollectorOn('checkin', { mail: false }), true);
  assert.equal(isCollectorOn('someday', { life: false }), true, 'unknown collectors always run');
});

test('a switched-off group is not read; back on brings it back', () => {
  let off = { life: false };
  let lifeReads = 0;
  const sources = {
    checkin: { collect: () => [{ id: 'life:checkin:x', kind: 'needs', source: 'life', title: 'Check-in', at: NOW }], read: () => { lifeReads += 1; return {}; } },
    update: { collect: () => [{ id: 'update:1', kind: 'info', source: 'update', title: 'Update', at: NOW }], read: () => ({}) },
  };
  const hub = createHub({
    sources,
    doneStore: createDoneStore({ file: () => null, now: () => NOW }),
    sourceFilter: () => (name) => isCollectorOn(name, off),
    now: () => NOW,
  });
  assert.deepEqual(hub.refresh(true).items.map((i) => i.id), ['update:1']);
  assert.equal(lifeReads, 0, 'not even read');
  off = {};
  assert.deepEqual(hub.refresh(true).items.map((i) => i.id), ['life:checkin:x', 'update:1']);
  const broken = createHub({ sources, doneStore: createDoneStore({ file: () => null, now: () => NOW }), sourceFilter: () => { throw new Error('prefs'); }, now: () => NOW });
  assert.equal(broken.refresh(true).items.length, 2, 'a broken setting keeps every source on');
});

test('registerHubIpc honours the stored hubSources', async () => {
  const handlers = new Map();
  let stored = { update: false };
  registerHubIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    send: () => {},
    doneFile: () => null,
    seenFile: () => null,
    runsDir: () => null,
    update: () => ({ state: 'available', info: { version: '9.9.9' } }),
    sourcePrefs: () => stored,
    readers: { checkin: () => ({}), goals: () => ({}), bills: () => ({}), todo: () => ({}), weekly: () => ({}) },
    autoStart: false,
  });
  assert.ok(!(await handlers.get('hub:list')()).items.some((i) => i.id === 'update:9.9.9'));
  stored = {};
  assert.ok((await handlers.get('hub:list')()).items.some((i) => i.id === 'update:9.9.9'));
});

test('the renderer switch list matches src/hubsources.js', () => {
  const src = read('src/renderer/modules/hubsettings.js');
  const m = /HUB_SOURCE_GROUPS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'the list is declared');
  const names = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(names, [...GROUP_NAMES]);
});

test('Settings markup and wiring', () => {
  const html = read('src/renderer/index.html');
  for (const id of ['hub-section', 'hubset-autoopen', 'hubset-toasts', 'hubset-sources', 'hubset-width-reset']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('id="hub-section"') > html.indexOf('id="termcustom-pane-notifications"'), 'in the Notifications pane');
  const custom = read('src/renderer/modules/termcustom.js');
  assert.ok(custom.includes("import { mountHubSettings } from './hubsettings.js'") && custom.includes('mountHubSettings(termcustomEl, prefs)'));
  const settings = read('src/renderer/modules/hubsettings.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(settings), 'textContent only');
  for (const key of ['hubAutoOpen', 'hubToasts', 'hubSources']) assert.ok(settings.includes(`${key}:`), `persists ${key}`);
  assert.ok(settings.includes('setHubToastsEnabled(') && settings.includes('resetHubWidth()') && settings.includes('refreshHub()'), 'applied live');
  assert.ok(read('src/renderer/modules/hubpanel.js').includes('export function resetHubWidth()'));
  assert.ok(read('src/renderer/modules/hubicon.js').includes('prefs.hubAutoOpen'), 'the launch auto-open reads the setting');
  assert.ok(read('src/renderer/modules/hubtoast.js').includes('prefs.hubToasts'), 'the toasts read the setting');
  assert.ok(read('src/main.js').includes('sourcePrefs: () => readUiPrefs().hubSources'), 'main hands the hub the source switches');
});

test('every hubset.* key is defined in pl and en', () => {
  const i18n = read('src/renderer/i18n.js');
  const enAt = i18n.indexOf('\n  en: {');
  const used = new Set();
  for (const src of [read('src/renderer/modules/hubsettings.js'), read('src/renderer/index.html')]) {
    for (const m of src.matchAll(/['"](hubset\.[a-zA-Z.]+[a-zA-Z])['"]/g)) used.add(m[1]);
  }
  for (const mode of ['always', 'needed', 'never']) used.add(`hubset.autoOpen.${mode}`);
  for (const group of GROUP_NAMES) used.add(`hubset.src.${group}`);
  assert.ok(used.size >= 15);
  for (const key of used) {
    assert.ok(i18n.slice(0, enAt).includes(`'${key}':`), `pl ${key}`);
    assert.ok(i18n.slice(enAt).includes(`'${key}':`), `en ${key}`);
  }
});
