// ============================================================================
// LunaCore - the project list as cloud units (src/projectsync.js)
// ----------------------------------------------------------------------------
// One unit per project, `proj:entry:<id>` = {label, path}. Paths under the
// home dir travel as "~/..." so they fit another user name. A PC adds the
// projects it lacks and drops the deleted ones, but never swaps the path of a
// project it already has: the folder may live elsewhere on this PC.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProjectsProvider, portablePath, validEntry, MAX_PROJECTS } = require('../src/projectsync.js');

const HOME = os.homedir();
const BASE = {
  activeProject: 'home',
  projects: [
    { id: 'home', label: 'Home (~)', path: '~' },
    { id: 'lunacore', label: 'Luna-Core-HUD', path: '~/Desktop/repos/Luna-Core-HUD' },
  ],
};

function setup(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-projsync-'));
  const baseFile = path.join(dir, 'projects.json');
  const localFile = path.join(dir, 'projects.local.json');
  fs.writeFileSync(baseFile, JSON.stringify(BASE));
  if (local !== undefined) fs.writeFileSync(localFile, typeof local === 'string' ? local : JSON.stringify(local));
  const provider = createProjectsProvider({ baseFile, localFile });
  return { provider, localFile, readLocal: () => JSON.parse(fs.readFileSync(localFile, 'utf8')) };
}

const unitMap = (units) => Object.fromEntries(units);

test('portablePath: under home -> ~/ with forward slashes, elsewhere unchanged', () => {
  assert.equal(portablePath(HOME), '~');
  assert.equal(portablePath(path.join(HOME, 'source', 'repos', 'x')), '~/source/repos/x');
  const outside = path.resolve('/opt/elsewhere');
  assert.equal(portablePath(outside), outside);
});

test('validEntry keeps a sane entry and refuses hostile ones', () => {
  assert.deepEqual(validEntry({ label: 'X', path: '~/x' }), { label: 'X', path: '~/x' });
  assert.deepEqual(validEntry({ label: 'X', path: '~' }), { label: 'X', path: '~' });
  assert.ok(validEntry({ label: 'X', path: path.resolve('/abs/dir') }));
  assert.equal(validEntry({ label: 'X', path: '\\\\server\\share' }), null, 'UNC path');
  assert.equal(validEntry({ label: 'X', path: '//server/share' }), null, 'UNC path, forward slashes');
  assert.equal(validEntry({ label: 'X', path: '\\??\\UNC\\host\\share' }), null, 'NT device path');
  assert.equal(validEntry({ label: 'X', path: '/??/UNC/host/share' }), null, 'NT device path, forward slashes');
  assert.equal(validEntry({ label: 'X', path: '\\\\.\\C:\\x' }), null, 'DOS device path');
  assert.equal(validEntry({ label: 'X', path: '\\x' }), null, 'drive-relative root');
  assert.ok(validEntry({ label: 'X', path: 'C:\\repos\\x' }));
  assert.ok(validEntry({ label: 'X', path: 'd:/repos/x' }));
  assert.equal(validEntry({ label: 'X', path: 'C:repos' }), null, 'drive-relative');
  assert.equal(validEntry({ label: 'X', path: 'relative/dir' }), null);
  assert.equal(validEntry({ label: 'X', path: '~/a\0b' }), null);
  assert.equal(validEntry({ label: '', path: '~/x' }), null);
  assert.equal(validEntry({ label: 'X'.repeat(500), path: '~/x' }), null);
  assert.equal(validEntry({ label: 'X', path: '~/' + 'a'.repeat(2000) }), null);
  assert.equal(validEntry(['X', '~/x']), null);
  assert.equal(validEntry(null), null);
});

test('valid() checks the id in the key too', () => {
  const { provider } = setup();
  assert.ok(provider.valid('proj:entry:my-app', { label: 'A', path: '~/a' }));
  assert.equal(provider.valid('proj:entry:__proto__', { label: 'A', path: '~/a' }), null);
  assert.equal(provider.valid('proj:entry:a b', { label: 'A', path: '~/a' }), null);
  assert.equal(provider.valid('proj:entry:', { label: 'A', path: '~/a' }), null);
  assert.ok(provider.owns('proj:entry:x'));
  assert.ok(!provider.owns('news:topic:x'));
});

test('read: every listed project becomes a unit, removedIds become tombstones', () => {
  const { provider } = setup({
    projects: [{ id: 'app', label: 'App', path: path.join(HOME, 'repos', 'app') }],
    removedIds: ['lunacore'],
  });
  const now = Date.now();
  const local = provider.read(now);
  assert.deepEqual(unitMap(local.units), {
    'proj:entry:home': { label: 'Home (~)', path: '~' },
    'proj:entry:app': { label: 'App', path: '~/repos/app' },
  });
  assert.ok(local.base > 0, 'first-sync base = the file mtime');
  // Stamped with the file's mtime, not now: a re-add made elsewhere later still wins.
  assert.deepEqual(local.gone, { 'proj:entry:lunacore': local.base });
});

test('read: no local file -> base 0, so a fresh PC never wins', () => {
  const { provider } = setup();
  const local = provider.read(5000);
  assert.equal(local.base, 0);
  assert.equal(local.units.length, 2);
});

test('read: a broken local file throws instead of reading as "all deleted"', () => {
  const { provider } = setup('{ not json');
  assert.throws(() => provider.read(5000));
});

test('resolve: a project this PC has keeps its own path', () => {
  const { provider } = setup({ projects: [{ id: 'app', label: 'App', path: 'D:\\work\\app' }] });
  const local = provider.read(1);
  const merged = [
    ...local.units.filter(([k]) => k !== 'proj:entry:app'),
    ['proj:entry:app', { label: 'App', path: '~/repos/app' }],
  ];
  const out = unitMap(provider.resolve(merged, local));
  assert.equal(out['proj:entry:app'].path, portablePath(path.normalize('D:\\work\\app')));
});

test('resolve: arrivals stop at MAX_PROJECTS, own projects always stay', () => {
  const { provider } = setup();
  const local = provider.read(1);
  const flood = Array.from({ length: MAX_PROJECTS + 50 }, (_, i) => [`proj:entry:f${i}`, { label: 'F', path: `~/f${i}` }]);
  const out = provider.resolve([...local.units, ...flood], local);
  assert.equal(out.length, MAX_PROJECTS);
  assert.deepEqual(out.slice(0, 2), local.units);
});

test('write: arrivals are added, deletions recorded, base entries not copied', () => {
  const { provider, readLocal } = setup({ activeProject: 'app', projects: [{ id: 'app', label: 'App', path: '~/repos/app' }] });
  const local = provider.read(1);
  const final = [
    ['proj:entry:home', { label: 'Home (~)', path: '~' }],
    ['proj:entry:app', { label: 'App', path: '~/repos/app' }],
    ['proj:entry:new', { label: 'New', path: '~/repos/new' }],
  ];
  provider.write(final, local);
  const doc = readLocal();
  assert.equal(doc.activeProject, 'app', 'other fields survive');
  assert.deepEqual(doc.projects, [
    { id: 'app', label: 'App', path: '~/repos/app' },
    { id: 'new', label: 'New', path: '~/repos/new' },
  ]);
  assert.deepEqual(doc.removedIds, ['lunacore']);
  assert.deepEqual(unitMap(provider.read(2).units), unitMap(final));
});

test('write: a project coming back is taken off removedIds', () => {
  const { provider, readLocal } = setup({ projects: [], removedIds: ['lunacore'] });
  const local = provider.read(1);
  provider.write([...local.units, ['proj:entry:lunacore', { label: 'Luna-Core-HUD', path: '~/Desktop/repos/Luna-Core-HUD' }]], local);
  assert.deepEqual(readLocal().removedIds, []);
  assert.deepEqual(readLocal().projects, [], 'the base entry itself is not copied');
});
