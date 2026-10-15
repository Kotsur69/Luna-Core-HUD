// ============================================================================
// LunaCore - config scope sync (src/configsync.js)
// ----------------------------------------------------------------------------
// The cloud's `config` scope carries machine-independent settings, one
// provider per kind (first: the project list). Two simulated PCs share a fake
// cloud with the server's newest-wins rule; the rows go through the real
// cloudrows mapping, so this is the same path the app takes.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigSync } = require('../src/configsync.js');
const { createProjectsProvider } = require('../src/projectsync.js');
const { mergeProjects } = require('../src/projects.js');
const rows = require('../src/cloudrows.js');

const BASE = {
  activeProject: 'home',
  projects: [
    { id: 'home', label: 'Home (~)', path: '~' },
    { id: 'lunacore', label: 'Luna-Core-HUD', path: '~/Desktop/repos/Luna-Core-HUD' },
  ],
};

/** sync_units for one scope: newest `u` wins per key, like push_units. */
function fakeCloud() {
  const mirror = {};
  return {
    mirror,
    peers: () => [rows.lifePeer(mirror)],
    publish(doc) {
      for (const x of rows.lifeUnits(doc)) {
        if (mirror[x.k] && !(x.u > mirror[x.k].u)) continue;
        mirror[x.k] = { v: x.v, u: x.u, d: x.d };
      }
    },
  };
}

function pc(cloud, clock, local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-configsync-'));
  const baseFile = path.join(dir, 'projects.json');
  const localFile = path.join(dir, 'projects.local.json');
  fs.writeFileSync(baseFile, JSON.stringify(BASE));
  if (local) fs.writeFileSync(localFile, typeof local === 'string' ? local : JSON.stringify(local));
  let online = true;
  const sync = createConfigSync({
    providers: [createProjectsProvider({ baseFile, localFile })],
    metaFile: path.join(dir, 'config-sync.local.json'),
    now: () => clock.t,
    extraPeers: () => (online ? cloud.peers() : null),
    onPublish: (doc) => cloud.publish(doc),
  });
  const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  return {
    localFile,
    sync: () => sync.syncOnce(),
    setOnline: (v) => (online = v),
    ids: () => mergeProjects(BASE, readJson(localFile)).projects.map((p) => p.id).sort(),
    project: (id) => (readJson(localFile)?.projects || []).find((p) => p.id === id),
    writeLocal: (doc) => fs.writeFileSync(localFile, JSON.stringify(doc)),
    readLocal: () => readJson(localFile),
  };
}

function setup(localA, localB) {
  const cloud = fakeCloud();
  const clock = { t: Date.UTC(2026, 9, 15, 12) };
  return { cloud, clock, a: pc(cloud, clock, localA), b: pc(cloud, clock, localB) };
}

const app = (id, p = `~/repos/${id}`) => ({ id, label: id.toUpperCase(), path: p });

test('cloud off: nothing is read, written or published', () => {
  const { a, cloud } = setup({ projects: [app('x')] });
  a.setOnline(false);
  assert.deepEqual(a.sync(), []);
  assert.deepEqual(cloud.mirror, {});
});

test('a project added on one PC shows up on the other', () => {
  const { a, b, clock } = setup({ projects: [app('x')] });
  assert.deepEqual(a.sync(), []);
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['projects']);
  assert.deepEqual(b.ids(), ['home', 'lunacore', 'x']);
  assert.deepEqual(b.project('x'), app('x'));
});

test('a fresh PC adds what it lacks and keeps nothing extra out of the cloud', () => {
  const { a, b, clock, cloud } = setup({ projects: [app('x')] }, { projects: [app('y')] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.deepEqual(a.ids(), ['home', 'lunacore', 'x', 'y']);
  assert.deepEqual(b.ids(), ['home', 'lunacore', 'x', 'y']);
  assert.ok(cloud.mirror['proj:entry:y']);
});

test('a project both PCs have keeps each PC its own path', () => {
  const { a, b, clock } = setup({ projects: [app('x', '~/repos/x')] }, { projects: [app('x', 'D:\\work\\x')] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.equal(a.project('x').path, '~/repos/x');
  assert.equal(b.project('x').path, 'D:\\work\\x');
  // Steady state: nothing keeps changing.
  clock.t += 1000;
  assert.deepEqual(a.sync(), []);
  assert.deepEqual(b.sync(), []);
});

test('a project removed on one PC is removed on the other', () => {
  const { a, b, clock } = setup({ projects: [app('x')] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  a.writeLocal({ projects: [], removedIds: ['x'] });
  a.sync();
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['projects']);
  assert.deepEqual(b.ids(), ['home', 'lunacore']);
});

test('a default removed long ago is not brought back by a fresh PC', () => {
  const { a, b, clock } = setup({ projects: [], removedIds: ['lunacore'] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  a.sync();
  assert.deepEqual(a.ids(), ['home']);
  assert.deepEqual(b.ids(), ['home']);
});

test('a broken local file is left alone and not published', () => {
  const { a, cloud } = setup('{ broken');
  assert.deepEqual(a.sync(), []);
  assert.equal(fs.readFileSync(a.localFile, 'utf8'), '{ broken');
  assert.deepEqual(cloud.mirror, {});
});

test('hostile cloud rows are dropped', () => {
  const { a, cloud, clock } = setup();
  cloud.mirror['proj:entry:evil'] = { v: { label: 'Evil', path: '\\\\attacker\\share' }, u: clock.t - 1, d: null };
  cloud.mirror['proj:entry:bad id'] = { v: { label: 'B', path: '~/b' }, u: clock.t - 1, d: null };
  cloud.mirror['proj:entry:future'] = { v: { label: 'F', path: '~/f' }, u: clock.t + 10 * 86400000, d: null };
  cloud.mirror['other:thing'] = { v: { a: 1 }, u: clock.t - 1, d: null };
  a.sync();
  assert.deepEqual(a.ids(), ['home', 'lunacore']);
});

test('no change -> stamps stay, nothing new to push', () => {
  const { a, clock, cloud } = setup({ projects: [app('x')] });
  a.sync();
  const before = cloud.mirror['proj:entry:x'].u;
  clock.t += 60000;
  a.sync();
  assert.equal(cloud.mirror['proj:entry:x'].u, before);
});
