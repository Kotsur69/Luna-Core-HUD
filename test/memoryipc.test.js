// ============================================================================
// LunaCore - memory inbox IPC, its hub item and its renderer wiring
// (src/memoryipc.js, src/hubcollect.js, renderer memoryinbox.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerMemoryIpc, cleanEdits } = require('../src/memoryipc.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { COLLECTORS } = require('../src/hubcollect.js');
const { ACTIONS } = require('../src/hub.js');

const PROJECT = 'github.com/acme/hud';
const KEY = `${PROJECT}/busy`;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-10',
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function setup(t, records = [rec('busy')]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memipc-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of records) writeRecord(dir, r);
  const handlers = {};
  let changed = 0;
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => changed++,
    captureStatus: () => ({ tracked: 2, last: null }),
    now: () => NOW,
  });
  const invoke = (channel, arg) => handlers[channel]({}, arg);
  return { dir, invoke, changed: () => changed, stored: () => Object.fromEntries(scan(dir).records) };
}

test('memory:inbox lists the waiting entries with the capture status', (t) => {
  const s = setup(t, [rec('busy'), rec('done', { confidence: 'confirmed' })]);

  const res = s.invoke('memory:inbox');

  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(res.items[0].key, KEY);
  assert.deepEqual(res.capture, { tracked: 2, last: null });
});

test('memory:approve confirms with today as the verification date and reports the change', (t) => {
  const s = setup(t);

  assert.deepEqual(s.invoke('memory:approve', KEY), { ok: true, key: KEY, removed: [] });

  assert.equal(s.stored()[KEY].confidence, 'confirmed');
  assert.equal(s.stored()[KEY].last_verified, '2026-11-11');
  assert.equal(s.changed(), 1);
});

test('memory:reject deletes the entry', (t) => {
  const s = setup(t);

  assert.equal(s.invoke('memory:reject', KEY).ok, true);

  assert.deepEqual(s.stored(), {});
});

test('memory:update changes only the editable fields', (t) => {
  const s = setup(t);

  assert.deepEqual(s.invoke('memory:update', { key: KEY, edits: { title: 'Retry says busy after sleep', confidence: 'confirmed', project: 'global' } }), { ok: true, key: KEY });

  assert.equal(s.stored()[KEY].title, 'Retry says busy after sleep');
  assert.equal(s.stored()[KEY].confidence, 'observed');
});

test('a bad key, a confirmed memory and bad edits are refused without a change', (t) => {
  const s = setup(t, [rec('done', { confidence: 'confirmed' })]);
  const confirmed = `${PROJECT}/done`;

  for (const key of [undefined, null, 5, {}, '', '../../x', 'C:\\Windows\\win.ini', 'x'.repeat(500)]) {
    assert.deepEqual(s.invoke('memory:approve', key), { ok: false, reason: 'bad-key' });
    assert.deepEqual(s.invoke('memory:reject', key), { ok: false, reason: 'bad-key' });
  }
  assert.deepEqual(s.invoke('memory:reject', confirmed), { ok: false, reason: 'not-pending' });
  assert.deepEqual(s.invoke('memory:approve', confirmed), { ok: false, reason: 'not-pending' });
  for (const req of [undefined, null, {}, { key: confirmed }, { key: confirmed, edits: 'x' }, { key: confirmed, edits: { title: 7 } }, { key: confirmed, edits: { body: 'x'.repeat(20000) } }]) {
    assert.deepEqual(s.invoke('memory:update', req), { ok: false, reason: 'bad-edits' });
  }
  assert.equal(s.changed(), 0);
  assert.equal(s.stored()[confirmed].confidence, 'confirmed');
});

test('cleanEdits keeps the four fields and drops the rest', () => {
  assert.deepEqual(cleanEdits({ title: 'a', body: 'b', type: 'gotcha', area: '', id: 'x', __proto__: { y: 1 } }), { title: 'a', body: 'b', type: 'gotcha', area: '' });
  assert.equal(cleanEdits([]), null);
});

test('the hub item counts the waiting memories and opens the inbox', () => {
  const [item] = COLLECTORS.memory({ count: 3, now: NOW });

  assert.equal(item.id, 'memory:inbox:3');
  assert.equal(item.kind, 'needs');
  assert.deepEqual(item.primary, { action: 'openMemoryInbox' });
  assert.ok(ACTIONS.has('openMemoryInbox'));
  for (const state of [null, {}, { count: 0, now: NOW }, { count: -1, now: NOW }, { count: '3', now: NOW }, { count: 3 }]) {
    assert.deepEqual(COLLECTORS.memory(state), []);
  }
});

test('the renderer inbox uses channels preload exposes and never writes markup', () => {
  const panel = read('src/renderer/modules/memoryinbox.js');
  const preload = read('src/preload.js');

  assert.doesNotMatch(panel, /innerHTML|outerHTML|insertAdjacentHTML/);
  const used = [...panel.matchAll(/'(memoryInbox\w*)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 4);
  for (const fn of [...used, 'onMemoryChanged']) assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
  for (const channel of ['memory:inbox', 'memory:approve', 'memory:reject', 'memory:update', 'memory:changed']) {
    assert.ok(preload.includes(`'${channel}'`), `${channel} is missing in preload`);
  }
});

test('every inbox string exists in Polish and English, Polish without diacritics', () => {
  const i18n = read('src/renderer/i18n.js');
  const panel = read('src/renderer/modules/memoryinbox.js');
  const keys = new Set([...panel.matchAll(/'(mem\.inbox\.[\w.]+)'/g)].map((m) => m[1]));
  for (const key of [...keys, 'hub.item.memoryInbox', 'hub.action.openMemoryInbox', 'hubset.src.memory']) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
});

test('the inbox styles use theme tokens only', () => {
  const css = read('src/renderer/styles.css');
  const rules = css.split('\n').filter((l) => l.includes('.mem-inbox'));

  assert.ok(rules.length > 5);
  for (const rule of rules) assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgb\(/, rule);
});
