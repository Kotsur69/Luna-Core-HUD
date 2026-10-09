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
  assert.deepEqual(store.loadProjects(f), { classes: {}, sharedDir: null, pinned: [] });
  fs.writeFileSync(f, '{oops');
  assert.deepEqual(store.loadProjects(f), { classes: {}, sharedDir: null, pinned: [] });
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
  assert.deepEqual(store.loadProjects(f), { classes: { 'local:ok': 'fun' }, sharedDir: null, pinned: [] });
});

test('setSharedDir keeps an absolute path and clears with null', () => {
  const f = file();
  const dir = path.resolve(os.tmpdir());
  assert.equal(store.setSharedDir(dir, f).sharedDir, dir);
  assert.equal(store.loadProjects(f).sharedDir, dir);
  assert.equal(store.setSharedDir(null, f).sharedDir, null);
  assert.throws(() => store.setSharedDir('relative/dir', f));
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
