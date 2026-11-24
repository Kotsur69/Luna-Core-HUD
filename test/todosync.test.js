// ============================================================================
// LunaCore - to-do sync between PCs (src/todosync.js)
// ----------------------------------------------------------------------------
// Mati adds different to-dos on different PCs: they must ADD UP, never
// overwrite each other. Ticks / edits / deletes sync too, newest wins.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('../src/todosync.js');

const item = (at, text, extra = {}) => ({ text, done: false, at, ...extra });
const empty = () => ({ snap: {}, u: {}, gone: {} });

test('stamp: new and edited items get the sync time, removed ones a tombstone', () => {
  const meta = sync.stamp([item(1, 'a'), item(2, 'b')], empty(), 100);
  assert.deepEqual(meta.u, { 1: 100, 2: 100 });
  const next = sync.stamp([item(3, 'c'), item(2, 'b', { done: true })], meta, 200);
  assert.deepEqual(next.u, { 2: 200, 3: 200 });
  assert.deepEqual(next.gone, { 1: 200 });
  // Unchanged items keep their old stamp.
  assert.equal(sync.stamp([item(3, 'c'), item(2, 'b', { done: true })], next, 300).u[2], 200);
});

test('merge: different additions on two PCs add up (nothing overwritten)', () => {
  const local = [item(1, 'from this PC')];
  const meta = sync.stamp(local, empty(), 100);
  const peer = { items: [{ ...item(2, 'from the laptop'), u: 90 }], gone: {} };
  const out = sync.merge(local, meta, [peer], 110);
  assert.deepEqual(out.list.map((x) => x.text), ['from this PC', 'from the laptop']);
  assert.equal(out.changed, true);
});

test('merge: the newest edit of the same item wins, either direction', () => {
  const local = [item(1, 'buy milk')];
  const meta = sync.stamp(local, empty(), 100);
  const newer = sync.merge(local, meta, [{ items: [{ ...item(1, 'buy milk', { done: true }), u: 150 }], gone: {} }], 160);
  assert.equal(newer.list[0].done, true);
  const older = sync.merge(local, meta, [{ items: [{ ...item(1, 'old text'), u: 50 }], gone: {} }], 160);
  assert.equal(older.list[0].text, 'buy milk');
  assert.equal(older.changed, false);
});

test('merge: a delete on another PC removes the item here; an edit made after it keeps it', () => {
  const local = [item(1, 'a'), item(2, 'b')];
  const meta = sync.stamp(local, empty(), 100);
  const out = sync.merge(local, meta, [{ items: [], gone: { 1: 120 } }], 130);
  assert.deepEqual(out.list.map((x) => x.at), [2]);
  // Edited here at 200, deleted there at 120: the later edit wins.
  const edited = sync.stamp([item(1, 'a!'), item(2, 'b')], meta, 200);
  const kept = sync.merge([item(1, 'a!'), item(2, 'b')], edited, [{ items: [], gone: { 1: 120 } }], 210);
  assert.deepEqual(kept.list.map((x) => x.at), [1, 2]);
});

test('merge: an item deleted here does not come back from a PC that still has the old copy', () => {
  const meta = sync.stamp([item(1, 'a'), item(2, 'b')], empty(), 100);
  const afterDelete = sync.stamp([item(2, 'b')], meta, 150);
  const out = sync.merge([item(2, 'b')], afterDelete, [{ items: [{ ...item(1, 'a'), u: 100 }], gone: {} }], 160);
  assert.deepEqual(out.list.map((x) => x.at), [2]);
});

test('merge: local order is kept; arrivals are appended oldest first; the cap holds', () => {
  const local = [item(5, 'e'), item(3, 'c')];
  const meta = sync.stamp(local, empty(), 100);
  const peer = { items: [9, 7].map((at) => ({ ...item(at, `p${at}`), u: 50 })), gone: {} };
  assert.deepEqual(sync.merge(local, meta, [peer], 110).list.map((x) => x.at), [5, 3, 7, 9]);
  const many = { items: Array.from({ length: 150 }, (_, i) => ({ ...item(1000 + i, `x${i}`), u: 50 })), gone: {} };
  assert.equal(sync.merge(local, meta, [many], 110).list.length, 100);
});

test('peer validation: junk, forged keys, future stamps and oversized lists are dropped', () => {
  const now = 1e12;
  const proj = sync.validPeerProjects(
    {
      'git:github.com/kotsur69/synthara': {
        items: [
          { text: 'ok', at: 5, done: false, u: now - 10 },
          { text: 'no stamp', at: 6 },
          { text: 'future', at: 7, u: now + 10 * 86400000 },
          { text: 42, at: 8, u: 1 },
          { text: 'no id', at: 0, u: 1 },
        ],
        gone: { 9: now - 5, nope: 3, 10: 'x' },
      },
      '../../etc': { items: [{ text: 'x', at: 1, u: 1 }], gone: {} },
      other: { items: [{ text: 'x', at: 1, u: 1 }], gone: {} },
    },
    now
  );
  assert.deepEqual(Object.keys(proj), ['git:github.com/kotsur69/synthara']);
  assert.deepEqual(proj['git:github.com/kotsur69/synthara'].items.map((x) => x.text), ['ok']);
  assert.deepEqual(proj['git:github.com/kotsur69/synthara'].gone, { 9: now - 5 });
});

// ---- createTodoSync over a fake cloud ---------------------------------------------

/** Every PC gets all published docs, its own included - like the real mirror (src/cloudsync.js). */
const fakeCloud = () => ({ docs: new Map() });
const cloudHooks = (cloud, name) => ({
  extraPeers: () => [...cloud.docs.values()],
  onPublish: (projects) => cloud.docs.set(name, projects),
});

function pc(name, cloud, lists) {
  const store = new Map(Object.entries(lists));
  const metaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `tsm-${name}-`)), 'meta.json');
  let clock = 1000;
  const s = sync.createTodoSync({
    machine: name,
    projects: () => [...store.keys()].map((id) => ({ id, path: `/repos/${id}` })),
    resolveKey: (p) => `git:github.com/kotsur69/${path.basename(p)}`,
    readTodos: (id) => store.get(id) || [],
    writeTodos: (id, list) => (store.set(id, list), true),
    metaFile,
    now: () => (clock += 1000),
    ...(cloud ? cloudHooks(cloud, name) : {}),
  });
  return { s, store };
}

test('two PCs through the cloud: both lists end up with both items', () => {
  const cloud = fakeCloud();
  const a = pc('DESK', cloud, { synthara: [item(1, 'desk idea')] });
  const b = pc('LAPTOP', cloud, { synthara: [item(2, 'laptop idea')] });
  a.s.syncAll();
  const changedB = b.s.syncAll();
  assert.deepEqual(changedB, ['synthara']);
  assert.deepEqual(b.store.get('synthara').map((x) => x.text).sort(), ['desk idea', 'laptop idea']);
  a.s.syncAll();
  assert.deepEqual(a.store.get('synthara').map((x) => x.text).sort(), ['desk idea', 'laptop idea']);
  // What goes up holds no paths, only keys.
  assert.equal(JSON.stringify(cloud.docs.get('DESK')).includes('/repos/'), false);
});

test('syncKey: repo key when there is one, else the project id (same on every PC)', () => {
  assert.equal(sync.syncKey('git:github.com/kotsur69/cru2026', 'cru2026'), 'git:github.com/kotsur69/cru2026');
  assert.equal(sync.syncKey('other', 'synthara'), 'local:synthara');
  assert.equal(sync.syncKey('other', ''), null);
  assert.equal(sync.syncKey('other', 'bad\u0000id'), null);
});

test('a repo on one PC meets the same project whose folder is missing on the other', () => {
  const cloud = fakeCloud();
  const a = pc('DESK', cloud, { synthara: [item(1, 'desk idea')] });
  const b = pc('LAPTOP', null, { synthara: [item(2, 'laptop idea')] });
  // On the laptop the folder is missing: no repo key, only the project id.
  const bSync = sync.createTodoSync({
    machine: 'LAPTOP',
    projects: () => [{ id: 'synthara', path: '' }],
    resolveKey: (_p, id) => sync.syncKey('other', id),
    readTodos: (id) => b.store.get(id) || [],
    writeTodos: (id, list) => (b.store.set(id, list), true),
    metaFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-')), 'm.json'),
    now: () => 2500, // same fake clock range as pc(): real time would read as "future"
    ...cloudHooks(cloud, 'LAPTOP'),
  });
  a.s.syncAll();
  bSync.syncAll();
  assert.deepEqual(b.store.get('synthara').map((x) => x.text).sort(), ['desk idea', 'laptop idea']);
  a.s.syncAll();
  assert.deepEqual(a.store.get('synthara').map((x) => x.text).sort(), ['desk idea', 'laptop idea']);
});

test('cloud off -> nothing happens, nothing throws', () => {
  const p = pc('DESK', null, { synthara: [item(1, 'x')] });
  assert.deepEqual(p.s.syncAll(), []);
});

// ---- the cloud as one mirror body (src/cloudsync.js) -----------------------------

function cloudPc(name, lists, cloudBody) {
  const store = new Map(Object.entries(lists));
  const published = [];
  const s = sync.createTodoSync({
    machine: name,
    projects: () => [...store.keys()].map((id) => ({ id, path: '' })),
    resolveKey: (_p, id) => sync.syncKey(null, id),
    readTodos: (id) => store.get(id) || [],
    writeTodos: (id, list) => (store.set(id, list), true),
    metaFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), `tsc-${name}-`)), 'm.json'),
    now: () => 5000,
    extraPeers: () => (cloudBody() ? [cloudBody()] : null),
    onPublish: (projects) => published.push(projects),
  });
  return { s, store, published };
}

test('local buckets meet through the cloud body', () => {
  let cloud = {};
  const a = cloudPc('DESK', { home: [item(1, 'milk')] }, () => cloud);
  const b = cloudPc('PHONE-ish', { home: [item(2, 'bread')] }, () => cloud);
  a.s.syncAll();
  cloud = a.published.at(-1);
  assert.ok(cloud['local:home']);
  assert.deepEqual(b.s.syncAll(), ['home']);
  assert.deepEqual(b.store.get('home').map((x) => x.text).sort(), ['bread', 'milk']);
});

test('first sync on a PC: its old copy of an item does not beat the cloud', () => {
  // The cloud has item 1 ticked (u 4000); this PC still has it unticked from an old copy.
  const cloud = { 'local:home': { items: [{ ...item(1, 'milk', { done: true }), u: 4000 }], gone: {} } };
  const b = cloudPc('LAPTOP', { home: [item(1, 'milk'), item(2, 'bread')] }, () => cloud);
  b.s.syncAll();
  assert.equal(b.store.get('home').find((x) => x.at === 1).done, true);
  // Items only this PC has still go up.
  const mine = b.published.at(-1)['local:home'].items;
  assert.deepEqual(mine.map((x) => x.at).sort(), [1, 2]);
});

test('after the first sync, a local edit gets a real stamp and wins', () => {
  const cloud = { 'local:home': { items: [{ ...item(1, 'milk'), u: 4000 }], gone: {} } };
  const b = cloudPc('LAPTOP', { home: [item(1, 'milk')] }, () => cloud);
  b.s.syncAll();
  b.store.set('home', [item(1, 'milk', { done: true })]);
  b.s.syncAll();
  const pub = b.published.at(-1)['local:home'].items.find((x) => x.at === 1);
  assert.equal(pub.done, true);
  assert.equal(pub.u, 5000);
});

test('stamp: an explicit base stamps new items (first sync uses 0)', () => {
  assert.deepEqual(sync.stamp([item(1, 'a')], empty(), 100, 0).u, { 1: 0 });
});

test('cloud off: nothing published', () => {
  const a = cloudPc('DESK', { home: [item(1, 'milk')] }, () => null);
  assert.deepEqual(a.s.syncAll(), []);
  assert.equal(a.published.length, 0);
});

test('tags survive HUD -> cloud rows -> PC peer and back unchanged', () => {
  const rows = require('../src/cloudrows.js');
  const now = 5_000_000;
  const tagged = item(7, 'steer me', { tags: ['steer', 'run:r1'] });
  // HUD publishes -> cloud units -> rows another machine pulls.
  const units = rows.todoUnits({ 'git:github.com/kotsur69/x': { items: [{ ...tagged, u: now }], gone: {} } });
  const pulled = rows.applyRows(
    { cursor: 0, mirror: {}, pushed: {} },
    units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })),
    now,
  );
  const peer = sync.validPeerProjects(rows.todoPeer(pulled.mirror), now);
  assert.deepEqual(peer['git:github.com/kotsur69/x'].items, [{ ...tagged, u: now }]);
  // Merged into a PC that has no copy yet: it arrives with its tags.
  const out = sync.merge([], empty(), [peer['git:github.com/kotsur69/x']], now);
  assert.deepEqual(out.list, [tagged]);
});

// ---- long cards: no stale build may cut them, and they round-trip whole -------

const rowsLib = require('../src/cloudrows.js');
const { normalizeTodo } = require('../src/todo.js');

test('merge: a newer copy an older build cut at 4000 does not replace the full details', () => {
  // The agy Live Map card (at=1795082538257): its details came back cut at
  // exactly 4000 mid-word after a device on a pre-v0.29 build touched it.
  const details = `### Slice 1\n${'map '.repeat(1100)}\n### Slice 2\n1. Rich ${'live '.repeat(1500)}\n### Slice 3\nend`;
  const full = normalizeTodo({ text: 'agy Live Map', details, acceptance: ['a'.repeat(700)], at: 1795082538257 });
  const local = [full];
  const meta = sync.stamp(local, empty(), 100);
  const stale = { ...full, done: true, details: details.slice(0, 4000), acceptance: ['a'.repeat(300)] };
  const peer = { items: [{ ...stale, u: 150 }], gone: {} };
  const out = sync.merge(local, meta, [peer], 200);
  assert.equal(out.list[0].details, details, 'details kept whole');
  assert.deepEqual(out.list[0].acceptance, full.acceptance, 'bullets kept whole');
  assert.equal(out.list[0].done, true, "the peer's real change (the tick) still lands");
  assert.ok(out.meta.u[full.at] > 150, 'the repaired card is stamped newer, so it goes back to the cloud');
  assert.equal(out.changed, true);
});

test('merge: a newer, genuinely shorter edit still wins', () => {
  const full = normalizeTodo({ text: 'T', details: 'd'.repeat(9000), at: 7 });
  const meta = sync.stamp([full], empty(), 100);
  const edited = { ...full, details: 'd'.repeat(2500) };
  const out = sync.merge([full], meta, [{ items: [{ ...edited, u: 150 }], gone: {} }], 200);
  assert.equal(out.list[0].details.length, 2500);
  assert.equal(out.meta.u[7], 150);
});

test('a card with 15000-20000 char details round-trips unchanged through the cloud rows', () => {
  const KEY = 'git:github.com/kotsur69/luna-core-hud';
  for (const size of [15000, 20000]) {
    const details = `# Plan\n${'x'.repeat(size - 12)}\nend.`;
    assert.equal(details.length, size);
    const card = normalizeTodo({ text: 'Long card', details, acceptance: ['a'.repeat(1000)], at: 1795082538257 });
    const units = rowsLib.todoUnits({ [KEY]: { items: [{ ...card, u: 500 }], gone: {} } });
    const pulled = rowsLib.applyRows(
      { cursor: 0, mirror: {}, pushed: {} },
      units.map((x, i) => ({ key: x.k, value: JSON.parse(JSON.stringify(x.v)), u: x.u, deleted_at: x.d, rev: i + 1 })),
      1000,
    );
    const peers = sync.validPeerProjects(rowsLib.todoPeer(pulled.mirror), 1000);
    assert.deepEqual(peers[KEY].items, [{ ...card, u: 500 }]);
    assert.equal(peers[KEY].items[0].details.length, size);
  }
});
