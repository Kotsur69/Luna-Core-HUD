// ============================================================================
// LunaCore - Mission Control project class store tests (src/missionprojects.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/missionprojects.js');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-proj-')), 'mission-projects.local.json');

test('a missing or broken file loads as empty', () => {
  const f = file();
  assert.deepEqual(store.loadProjects(f), { classes: {}, pinned: [], unpinned: [] });
  fs.writeFileSync(f, '{oops');
  assert.deepEqual(store.loadProjects(f), { classes: {}, pinned: [], unpinned: [] });
});

test('setClass stores work / fun / other and null unassigns', () => {
  const f = file();
  store.setClass('git:github.com/me/app', 'work', f);
  store.setClass('local:toy', 'fun', f);
  assert.deepEqual(store.loadProjects(f).classes, { 'git:github.com/me/app': 'work', 'local:toy': 'fun' });
  store.setClass('local:toy', null, f);
  assert.deepEqual(store.loadProjects(f).classes, { 'git:github.com/me/app': 'work' });
});

test('setClass rejects unknown classes and keys that are not project keys', () => {
  const f = file();
  assert.throws(() => store.setClass('git:github.com/me/app', 'boss', f));
  assert.throws(() => store.setClass('C:\\Windows', 'work', f));
  assert.throws(() => store.setClass(undefined, 'work', f));
  assert.throws(() => store.setClass('__proto__', 'work', f));
});

test('loading drops bad entries written by hand', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ classes: { 'local:ok': 'fun', 'local:bad': 'boss', 'not a key': 'work' }, sharedDir: 42 })
  );
  assert.deepEqual(store.loadProjects(f), { classes: { 'local:ok': 'fun' }, pinned: [], unpinned: [] });
});

test('a sharedDir left by the old folder sync is dropped on the next save', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ classes: {}, sharedDir: 'C:/Users/x/LunaLedger', pinned: [] }));
  assert.equal('sharedDir' in store.loadProjects(f), false);
  store.setClass('local:toy', 'fun', f);
  assert.equal('sharedDir' in JSON.parse(fs.readFileSync(f, 'utf8')), false);
});

test('setPinned stores pinned projects with folder aliases', () => {
  const f = file();
  store.setPinned([
    { key: 'git:github.com/kotsur69/synthara', name: 'synthara', folders: ['synthara'] },
    { key: 'bad key', name: 'x', folders: [] },
    { key: 'git:github.com/kotsur69/blade-bullet', name: 'blade&bullet', folders: ['blade&bullet', '../evil', 'a/b'] },
  ], f);
  assert.deepEqual(store.loadProjects(f).pinned, [
    { key: 'git:github.com/kotsur69/synthara', name: 'synthara', folders: ['synthara'] },
    { key: 'git:github.com/kotsur69/blade-bullet', name: 'blade&bullet', folders: ['blade&bullet'] },
  ]);
});

test('setClass keeps pinned projects', () => {
  const f = file();
  store.setPinned([{ key: 'local:toy', name: 'toy', folders: [] }], f);
  store.setClass('local:toy', 'fun', f);
  assert.equal(store.loadProjects(f).pinned.length, 1);
});

test('setPin pins a new project with no folders and unpins it again', () => {
  const f = file();
  store.setPin('local:toy', true, 'toy', f);
  assert.deepEqual(store.loadProjects(f).pinned, [{ key: 'local:toy', name: 'toy', folders: [] }]);
  store.setPin('local:toy', false, 'toy', f);
  const cur = store.loadProjects(f);
  assert.deepEqual(cur.pinned, []);
  assert.deepEqual(cur.unpinned, [{ key: 'local:toy', name: 'toy', folders: [] }]);
});

test('unpinning keeps folder aliases and re-pinning restores them', () => {
  const f = file();
  store.setPinned([{ key: 'git:github.com/kotsur69/synthara', name: 'synthara', folders: ['synthara', 'synthara-old'] }], f);
  store.setPin('git:github.com/kotsur69/synthara', false, 'ignored', f);
  const parked = store.loadProjects(f);
  assert.deepEqual(parked.pinned, []);
  assert.deepEqual(store.pinnedAliases(store.aliasEntries(parked)).get('synthara-old'), {
    key: 'git:github.com/kotsur69/synthara',
    name: 'synthara',
  });
  store.setPin('git:github.com/kotsur69/synthara', true, 'ignored', f);
  const back = store.loadProjects(f);
  assert.deepEqual(back.pinned, [{ key: 'git:github.com/kotsur69/synthara', name: 'synthara', folders: ['synthara', 'synthara-old'] }]);
  assert.deepEqual(back.unpinned, []);
});

test('setPin keeps classes and other pins, and rejects bad keys and names', () => {
  const f = file();
  store.setClass('local:toy', 'fun', f);
  store.setPin('local:a', true, 'a', f);
  store.setPin('local:b', true, 'b', f);
  store.setPin('local:a', false, 'a', f);
  const cur = store.loadProjects(f);
  assert.deepEqual(cur.pinned.map((p) => p.key), ['local:b']);
  assert.deepEqual(cur.classes, { 'local:toy': 'fun' });
  assert.throws(() => store.setPin('C:\\Windows', true, 'x', f));
  assert.throws(() => store.setPin('local:c', true, 'bad\u0000name', f));
  assert.throws(() => store.setPin('local:c', true, undefined, f));
});

test('a key both pinned and unpinned by hand loads as pinned only', () => {
  const f = file();
  const pin = { key: 'local:toy', name: 'toy', folders: ['toy'] };
  fs.writeFileSync(f, JSON.stringify({ classes: {}, pinned: [pin], unpinned: [pin] }));
  assert.deepEqual(store.loadProjects(f), { classes: {}, pinned: [pin], unpinned: [] });
});
