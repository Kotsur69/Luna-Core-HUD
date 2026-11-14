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

const { registerMemoryIpc, cleanEdits, cleanSearchMode, reviewCount } = require('../src/memoryipc.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { COLLECTORS } = require('../src/hubcollect.js');
const { createLog, logPath } = require('../src/memorylog.js');
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

function setup(t, records = [rec('busy')], { roots, searchStatus } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memipc-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const r of records) writeRecord(dir, r);
  const handlers = {};
  let changed = 0;
  const log = createLog(logPath(base), { now: () => NOW });
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => changed++,
    captureStatus: () => ({ tracked: 2, last: null }),
    now: () => NOW,
    log,
    roots: roots || (() => ({ [PROJECT]: repo })),
    ...(searchStatus ? { searchStatus } : {}),
  });
  const invoke = (channel, arg) => handlers[channel]({}, arg);
  const logged = () => log.read().map(({ at, ...event }) => event);
  return { dir, repo, log, logged, invoke, changed: () => changed, stored: () => Object.fromEntries(scan(dir).records) };
}

// ---- phase 2b: which search is in use --------------------------------------------

test('memory:inbox says how search answers on this PC, and passes nothing else along', (t) => {
  const meaning = { mode: 'meaning', model: 'm'.repeat(500), embedded: 3, total: -1, extra: 'dropped' };
  const s = setup(t, undefined, { searchStatus: () => meaning });

  assert.deepEqual(s.invoke('memory:inbox').search, { mode: 'meaning', model: 'm'.repeat(120), embedded: 3, total: 0 });
  assert.deepEqual(cleanSearchMode({ mode: 'keywords', reason: 'no-server' }), { mode: 'keywords', reason: 'no-server' });
  assert.deepEqual(cleanSearchMode({ mode: 'keywords', reason: '<b>x</b>' }), { mode: 'keywords', reason: 'failed' });
  assert.equal(cleanSearchMode({ mode: 'other' }), null);
});

test('memory:inbox still lists when the search status is missing or throws', (t) => {
  const none = setup(t);
  const broken = setup(t, undefined, {
    searchStatus: () => {
      throw new Error('boom');
    },
  });

  assert.equal(none.invoke('memory:inbox').search, null);
  assert.equal(broken.invoke('memory:inbox').ok, true);
  assert.equal(broken.invoke('memory:inbox').search, null);
});

// ---- phase 5: the decisions log, the review list --------------------------------

test('every inbox decision is logged, and only a rejection keeps its title', (t) => {
  const s = setup(t, [rec('busy'), rec('noise')]);

  s.invoke('memory:update', { key: KEY, edits: { title: 'Retry says busy after sleep' } });
  s.invoke('memory:approve', KEY);
  s.invoke('memory:reject', `${PROJECT}/noise`);
  s.invoke('memory:reject', `${PROJECT}/nope`);

  assert.deepEqual(s.logged(), [
    { ev: 'edited', key: KEY, type: 'gotcha' },
    { ev: 'approved', key: KEY, type: 'gotcha' },
    { ev: 'rejected', key: `${PROJECT}/noise`, type: 'gotcha', title: 'Title of noise' },
  ]);
});

test('a decision carries the usefulness score of the entry to the log', (t) => {
  const s = setup(t, [rec('busy', { usefulness: 72 }), rec('noise', { usefulness: 35 })]);

  s.invoke('memory:approve', KEY);
  s.invoke('memory:reject', `${PROJECT}/noise`);

  assert.deepEqual(s.logged(), [
    { ev: 'approved', key: KEY, type: 'gotcha', usefulness: 72 },
    { ev: 'rejected', key: `${PROJECT}/noise`, type: 'gotcha', title: 'Title of noise', usefulness: 35 },
  ]);
});

test('memory:inbox reports the last week of capture: proposed, decided and the approval rate', (t) => {
  // Distinct texts: near-duplicates would be folded into one inbox entry.
  const s = setup(t, [
    rec('a', { title: 'Packaging times out on battery', body: 'Check the power events first.' }),
    rec('b', { title: 'Retry says busy after sleep', body: 'Restart the app.' }),
    rec('c', { title: 'Name the installer with dashes', body: 'Auto-update breaks on spaces.' }),
  ]);
  for (const id of ['a', 'b', 'c']) s.log.add({ ev: 'proposed', key: `${PROJECT}/${id}`, type: 'gotcha' });
  s.invoke('memory:approve', `${PROJECT}/a`);
  s.invoke('memory:reject', `${PROJECT}/b`);

  assert.deepEqual(s.invoke('memory:inbox').stats, { days: 7, captures: 0, proposed: 3, approved: 1, rejected: 1, edited: 0, rate: 0.5 });
});

test('memory:review lists a confirmed memory whose file is gone; "still true" clears it', (t) => {
  const s = setup(t, [rec('broken', { confidence: 'confirmed', body: 'The poller is in `src/removed.js`.' }), rec('busy')]);
  const key = `${PROJECT}/broken`;

  const before = s.invoke('memory:review');
  const verified = s.invoke('memory:verify', key);

  assert.equal(before.ok, true);
  assert.equal(before.total, 1);
  assert.deepEqual(before.items[0].flags, [{ kind: 'anchor', missing: ['src/removed.js'] }]);
  assert.deepEqual(verified, { ok: true, key });
  assert.equal(s.stored()[key].last_verified, '2026-11-11');
  assert.equal(s.invoke('memory:review').total, 0);
  assert.equal(s.changed(), 1);
});

test('memory:retire deletes a confirmed memory and logs it', (t) => {
  const s = setup(t, [rec('old', { confidence: 'confirmed', created: '2026-01-01' })]);
  const key = `${PROJECT}/old`;

  assert.deepEqual(s.invoke('memory:retire', key), { ok: true, key });

  assert.deepEqual(s.stored(), {});
  assert.deepEqual(s.logged(), [{ ev: 'retired', key, type: 'gotcha', title: 'Title of old' }]);
});

test('verify and retire refuse a bad key and a memory that still waits in the inbox', (t) => {
  const s = setup(t);

  for (const channel of ['memory:verify', 'memory:retire']) {
    for (const key of [undefined, null, 5, {}, '', '../../x', 'C:\\Windows\\win.ini', 'x'.repeat(500)]) {
      assert.deepEqual(s.invoke(channel, key), { ok: false, reason: 'bad-key' });
    }
    assert.deepEqual(s.invoke(channel, KEY), { ok: false, reason: 'not-confirmed' });
  }
  assert.equal(s.changed(), 0);
  assert.equal(s.stored()[KEY].confidence, 'observed');
  assert.deepEqual(s.logged(), []);
});

test('the window can settle only a memory that is on the review list', (t) => {
  const s = setup(t, [rec('healthy', { confidence: 'confirmed' })]);
  const key = `${PROJECT}/healthy`;

  assert.deepEqual(s.invoke('memory:retire', key), { ok: false, reason: 'not-flagged' });
  assert.deepEqual(s.invoke('memory:verify', key), { ok: false, reason: 'not-flagged' });

  assert.equal(s.stored()[key].last_verified, undefined);
  assert.equal(s.changed(), 0);
  assert.deepEqual(s.logged(), []);
});

test('project folders that cannot be named do not hide the review list', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const s = setup(t, [rec('stale', { confidence: 'confirmed', created: '2026-01-01' })], {
    roots: () => {
      throw new Error('boom');
    },
  });

  const res = s.invoke('memory:review');

  assert.equal(res.total, 1);
  assert.equal(res.items[0].flags[0].kind, 'stale');
  assert.equal(quiet.mock.callCount(), 1);
});

test('reviewCount counts the flagged memories and is zero when the mirror cannot be read', (t) => {
  const s = setup(t, [rec('stale', { confidence: 'confirmed', created: '2026-01-01' }), rec('fine', { confidence: 'confirmed' })]);
  const quiet = t.mock.method(console, 'error', () => {});

  assert.equal(reviewCount({ dir: s.dir, today: '2026-11-11' }), 1);
  assert.equal(reviewCount({ dir: null, today: '2026-11-11' }), 0);
  assert.equal(quiet.mock.callCount(), 1);
});

test('the review list uses channels preload exposes', () => {
  const panel = read('src/renderer/modules/memoryinbox.js');
  const preload = read('src/preload.js');

  const used = [...panel.matchAll(/'(memoryReview\w*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['memoryReview', 'memoryReviewRetire', 'memoryReviewVerify']);
  for (const fn of used) assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
  for (const channel of ['memory:review', 'memory:verify', 'memory:retire']) assert.ok(preload.includes(`'${channel}'`), `${channel} is missing in preload`);
});

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

test('memory:make-global moves a waiting project entry to global and reports its new key', (t) => {
  const s = setup(t, [rec('busy', { source: 'captured from session abc on PC1, suggested global' })]);

  assert.deepEqual(s.invoke('memory:make-global', KEY), { ok: true, key: 'global/busy' });

  assert.equal(s.stored()[KEY], undefined);
  assert.equal(s.stored()['global/busy'].confidence, 'observed');
  assert.equal(s.stored()['global/busy'].source, 'captured from session abc on PC1');
  assert.equal(s.changed(), 1);
});

test('memory:make-global refuses a bad key, a confirmed memory and a global one without a change', (t) => {
  const s = setup(t, [rec('done', { confidence: 'confirmed' }), rec('everywhere', { project: 'global' })]);
  const before = s.stored();

  for (const key of [undefined, null, 5, {}, [], '', '../../x', 'C:\\Windows\\win.ini', 'x'.repeat(500)]) {
    assert.deepEqual(s.invoke('memory:make-global', key), { ok: false, reason: 'bad-key' });
  }
  assert.deepEqual(s.invoke('memory:make-global', `${PROJECT}/done`), { ok: false, reason: 'not-pending' });
  assert.deepEqual(s.invoke('memory:make-global', 'global/everywhere'), { ok: false, reason: 'already-global' });
  assert.equal(s.changed(), 0);
  assert.deepEqual(s.stored(), before);
});

test('memory:inbox items carry the suggested-global mark and the outside count', (t) => {
  const s = setup(t, [rec('busy', { source: 'captured from session abc on PC1, read 3 outside source(s), suggested global' })]);

  const [item] = s.invoke('memory:inbox').items;

  assert.equal(item.suggestedGlobal, true);
  assert.equal(item.outside, 3);
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
  for (const channel of ['memory:inbox', 'memory:approve', 'memory:reject', 'memory:update', 'memory:make-global', 'memory:changed']) {
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

// ---- the graveyard (src/memorygraveyard.js) --------------------------------------

const graveyard = require('../src/memorygraveyard.js');
const { LOW_USEFULNESS } = require('../src/memoryextract.js');

function graveSetup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memipc-grave-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  const file = graveyard.graveyardPath(base);
  const handlers = {};
  let changed = 0;
  const log = createLog(logPath(base), { now: () => NOW });
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => changed++,
    now: () => NOW,
    log,
    graveyardFile: () => file,
  });
  const dropped = (id) => ({ title: `Title of ${id}`, reason: LOW_USEFULNESS, record: rec(id, { usefulness: 9 }) });
  graveyard.bury(file, [dropped('weak-one'), dropped('weak-two')], NOW);
  return { dir, file, log, invoke: (channel, arg) => handlers[channel]({}, arg), changed: () => changed };
}

test('memory:graveyard lists the entries under their entry id', (t) => {
  const s = graveSetup(t);
  const res = s.invoke('memory:graveyard');
  assert.equal(res.ok, true);
  assert.equal(res.total, 2);
  assert.deepEqual(res.items.map((i) => [i.title, i.usefulness, i.reason]).sort(), [
    ['Title of weak-one', 9, LOW_USEFULNESS],
    ['Title of weak-two', 9, LOW_USEFULNESS],
  ]);
  for (const item of res.items) assert.equal(graveyard.isEntryId(item.key), true);
});

test('memory:graveyard-restore puts the entry in the inbox as observed and logs `restored`', (t) => {
  const s = graveSetup(t);
  const [item] = s.invoke('memory:graveyard').items;

  const res = s.invoke('memory:graveyard-restore', item.key);

  const restoredKey = `${PROJECT}/${item.title === 'Title of weak-one' ? 'weak-one' : 'weak-two'}`;
  assert.deepEqual(res, { ok: true, key: restoredKey });
  assert.equal(s.changed(), 1, 'the mirror changed: sync and repaint');
  assert.deepEqual(s.invoke('memory:inbox').items.map((i) => i.key), [restoredKey]);
  assert.equal(Object.fromEntries(scan(s.dir).records)[restoredKey].confidence, 'observed');
  assert.equal(s.invoke('memory:graveyard').total, 1);
  assert.deepEqual(s.log.read().map(({ at, ...e }) => e), [{ ev: 'restored', key: restoredKey, type: 'gotcha', title: item.title, usefulness: 9 }]);
});

test('memory:graveyard-delete removes one entry and touches nothing else', (t) => {
  const s = graveSetup(t);
  const [item] = s.invoke('memory:graveyard').items;

  assert.deepEqual(s.invoke('memory:graveyard-delete', item.key), { ok: true, key: item.key });
  assert.equal(s.invoke('memory:graveyard').total, 1);
  assert.deepEqual(scan(s.dir).records, []);
  assert.equal(s.changed(), 0, 'a local delete syncs nothing');
});

test('the graveyard channels refuse a bad key or index from the renderer', (t) => {
  const s = graveSetup(t);
  const bad = [undefined, null, 0, 1, -1, '', '../memory-log.local.jsonl', `${PROJECT}/weak-one`, 'ABC-0000beef', 'a'.repeat(500), { key: 'x' }, ['x']];
  for (const key of bad) {
    assert.deepEqual(s.invoke('memory:graveyard-restore', key), { ok: false, reason: 'bad-key' }, `restore ${JSON.stringify(key)}`);
    assert.deepEqual(s.invoke('memory:graveyard-delete', key), { ok: false, reason: 'bad-key' }, `delete ${JSON.stringify(key)}`);
  }
  assert.deepEqual(s.invoke('memory:graveyard-restore', 'zzz-00000000'), { ok: false, reason: 'not-found' });
  assert.deepEqual(s.invoke('memory:graveyard-delete', 'zzz-00000000'), { ok: false, reason: 'not-found' });
  assert.equal(s.invoke('memory:graveyard').total, 2);
  assert.deepEqual(scan(s.dir).records, []);
});

test('without a graveyard file the list is empty and the actions fail softly', (t) => {
  const handlers = {};
  registerMemoryIpc({ ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) }, dir: () => os.tmpdir(), now: () => NOW });
  assert.deepEqual(handlers['memory:graveyard']({}), { ok: true, items: [], total: 0 });
  assert.deepEqual(handlers['memory:graveyard-delete']({}, 'zzz-00000000'), { ok: false, reason: 'failed' });
});

test('the graveyard tab uses channels preload exposes; its strings exist in Polish and English', () => {
  const panel = read('src/renderer/modules/memoryinbox.js');
  const preload = read('src/preload.js');
  const i18n = read('src/renderer/i18n.js');

  const used = [...panel.matchAll(/'(memoryGraveyard\w*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['memoryGraveyard', 'memoryGraveyardDelete', 'memoryGraveyardRestore']);
  for (const fn of used) assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
  for (const channel of ['memory:graveyard', 'memory:graveyard-restore', 'memory:graveyard-delete']) assert.ok(preload.includes(`'${channel}'`));
  assert.match(panel, /\['graveyard', 'mem\.inbox\.tab\.graveyard'\]/);
  const keys = new Set([...panel.matchAll(/'(mem\.grave\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size >= 5);
  for (const key of [...keys, 'mem.inbox.tab.graveyard', 'hub.item.memoryDigest', 'hub.item.memoryDigestDetail']) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
});
