// ============================================================================
// LunaCore - Mission Control settings over the cloud (src/missionsync.js)
// ----------------------------------------------------------------------------
// News sources / topics travel one unit per item; project classes one unit
// per project key, the pinned list as one unit. A legacy sharedDir never leaves
// the PC and is dropped on write.
// Two simulated PCs share a fake cloud that reorders keys like jsonb.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigSync } = require('../src/configsync.js');
const { createNewsProvider, createMissionProjectsProvider } = require('../src/missionsync.js');
const rows = require('../src/cloudrows.js');

function jsonbOrder(v) {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder(v[k])]));
}

function fakeCloud() {
  const mirror = {};
  return {
    mirror,
    peers: () => [rows.lifePeer(mirror)],
    publish(doc) {
      for (const x of rows.lifeUnits(doc)) {
        if (mirror[x.k] && !(x.u > mirror[x.k].u)) continue;
        mirror[x.k] = { v: jsonbOrder(x.v), u: x.u, d: x.d };
      }
    },
  };
}

const NEWS = 'mission-news.local.json';
const MP = 'mission-projects.local.json';

function pc(cloud, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-missionsync-'));
  const file = (name) => path.join(dir, name);
  const sync = createConfigSync({
    providers: [createNewsProvider(file(NEWS)), createMissionProjectsProvider(file(MP))],
    metaFile: file('config-sync.local.json'),
    now: () => clock.t,
    extraPeers: () => cloud.peers(),
    onPublish: (doc) => cloud.publish(doc),
  });
  return {
    file,
    sync: () => sync.syncOnce(),
    write(name, doc, mtime = clock.t) {
      fs.writeFileSync(file(name), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
      fs.utimesSync(file(name), new Date(mtime), new Date(mtime));
    },
    read: (name) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : null),
    raw: (name) => fs.readFileSync(file(name), 'utf8'),
  };
}

function setup() {
  const cloud = fakeCloud();
  const clock = { t: Date.UTC(2026, 9, 15, 12) };
  return { cloud, clock, a: pc(cloud, clock), b: pc(cloud, clock) };
}

const src = (id, target) => ({ id, platform: 'reddit', target, label: `r/${target}` });
const topic = (id, query) => ({ id, query, platforms: ['hackernews'] });
const ids = (list) => list.map((x) => x.id).sort();

test('news sources and topics added on one PC show up on the other', () => {
  const { a, b, clock, cloud } = setup();
  a.write(NEWS, { sources: [src('s-1', 'Anthropic')], topics: [topic('t-1', 'claude')] });
  a.sync();
  assert.ok(cloud.mirror['news:source:s-1']);
  assert.ok(cloud.mirror['news:topic:t-1']);
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['news']);
  assert.deepEqual(b.read(NEWS), { sources: [src('s-1', 'Anthropic')], topics: [topic('t-1', 'claude')] });
});

test("both PCs keep their own sources and gain the other one's", () => {
  const { a, b, clock } = setup();
  a.write(NEWS, { sources: [src('s-1', 'Anthropic')], topics: [] });
  b.write(NEWS, { sources: [src('s-2', 'LocalLLaMA')], topics: [] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.deepEqual(ids(a.read(NEWS).sources), ['s-1', 's-2']);
  assert.deepEqual(ids(b.read(NEWS).sources), ['s-1', 's-2']);
});

test('a source removed on one PC is removed on the other; the round trip settles', () => {
  const { a, b, clock } = setup();
  a.write(NEWS, { sources: [src('s-1', 'Anthropic'), src('s-2', 'LocalLLaMA')], topics: [] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 60000;
  a.write(NEWS, { sources: [src('s-2', 'LocalLLaMA')], topics: [] });
  a.sync();
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['news']);
  assert.deepEqual(ids(b.read(NEWS).sources), ['s-2']);
  for (let i = 0; i < 3; i++) {
    clock.t += 60000;
    assert.deepEqual(a.sync(), []);
    assert.deepEqual(b.sync(), []);
  }
});

test('hostile news rows are dropped', () => {
  const { a, clock, cloud } = setup();
  const u = clock.t - 1;
  cloud.mirror['news:source:s-ok'] = { v: { platform: 'reddit', target: 'Anthropic', label: 'r/Anthropic' }, u, d: null };
  cloud.mirror['news:source:BAD ID'] = { v: { platform: 'reddit', target: 'x1', label: 'x' }, u, d: null };
  cloud.mirror['news:source:s-evil'] = { v: { platform: 'shell', target: 'rm -rf', label: 'x' }, u, d: null };
  cloud.mirror['news:topic:t-flag'] = { v: { query: '', platforms: ['github'] }, u, d: null };
  a.sync();
  assert.deepEqual(ids(a.read(NEWS).sources), ['s-ok']);
  assert.deepEqual(a.read(NEWS).topics, []);
});

test('sources without a valid id stay in the file but are not synced', () => {
  const { a, cloud } = setup();
  a.write(NEWS, { sources: [{ platform: 'reddit', target: 'NoId' }, src('s-1', 'Anthropic')], topics: [] });
  a.sync();
  assert.deepEqual(Object.keys(cloud.mirror), ['news:source:s-1']);
  assert.equal(a.read(NEWS).sources.length, 2);
});

test('project classes and pinned travel; a legacy sharedDir never goes up', () => {
  const { a, b, clock, cloud } = setup();
  const pinned = [{ key: 'git:github.com/x/y', name: 'Y', folders: ['y'] }];
  a.write(MP, { classes: { 'git:github.com/x/y': 'work', 'local:home': 'fun' }, sharedDir: 'C:\\A', pinned });
  b.write(MP, { classes: {}, sharedDir: 'D:\\B', pinned: [] }, clock.t - 90000);
  a.sync();
  assert.equal(JSON.stringify(cloud.mirror).includes('C:\\\\A'), false);
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['missionProjects']);
  const got = b.read(MP);
  assert.deepEqual(got.classes, { 'git:github.com/x/y': 'work', 'local:home': 'fun' });
  assert.deepEqual(got.pinned, pinned);
  assert.equal('sharedDir' in got, false);
});

test('a class changed on one PC wins on the other; clearing it clears it there', () => {
  const { a, b, clock } = setup();
  a.write(MP, { classes: { other: 'work' }, pinned: [] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 60000;
  b.write(MP, { ...b.read(MP), classes: { other: 'fun' } });
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.deepEqual(a.read(MP).classes, { other: 'fun' });
  clock.t += 60000;
  a.write(MP, { ...a.read(MP), classes: {} });
  a.sync();
  clock.t += 1000;
  b.sync();
  assert.deepEqual(b.read(MP).classes, {});
});

test('hostile project rows are dropped', () => {
  const { a, clock, cloud } = setup();
  const u = clock.t - 1;
  cloud.mirror['proj:class:other'] = { v: { class: 'admin' }, u, d: null };
  cloud.mirror['proj:class:../../x'] = { v: { class: 'work' }, u, d: null };
  cloud.mirror['proj:pinned'] = { v: { list: [{ key: 'local:a', name: 'A', folders: ['..', 'ok'] }] }, u, d: null };
  a.sync();
  const got = a.read(MP);
  assert.deepEqual(got.classes, {});
  assert.deepEqual(got.pinned, [{ key: 'local:a', name: 'A', folders: ['ok'] }]);
});

test('broken files are left alone and not published', () => {
  const { a, cloud } = setup();
  a.write(NEWS, '{ broken');
  a.write(MP, '[1, 2]');
  assert.deepEqual(a.sync(), []);
  assert.equal(a.raw(NEWS), '{ broken');
  assert.deepEqual(cloud.mirror, {});
});

test('a unit the server would refuse stays local and does not block the others', () => {
  const { a, cloud } = setup();
  const longKey = `git:github.com/${'x'.repeat(250)}/y`;
  const big = Array.from({ length: 20 }, (_, i) => ({ key: `local:p${i}`, name: 'ą'.repeat(100), folders: ['ż'.repeat(100)] }));
  a.write(MP, { classes: { [longKey]: 'work', other: 'fun' }, pinned: big });
  a.sync();
  assert.deepEqual(Object.keys(cloud.mirror), ['proj:class:other']);
  assert.equal(Object.keys(a.read(MP).classes).length, 2);
  assert.equal(a.read(MP).pinned.length, 20);
});

test('a topic query cannot start with a dash, however it is spaced', () => {
  const { a, clock, cloud } = setup();
  cloud.mirror['news:topic:t-1'] = { v: { query: '- -x --y', platforms: ['github'] }, u: clock.t - 1, d: null };
  a.sync();
  assert.equal(a.read(NEWS).topics[0].query, 'x --y');
});
