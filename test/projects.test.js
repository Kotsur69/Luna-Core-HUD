// Tests for the project switcher. The crux: expanding "~" - it is what makes
// the config PORTABLE between machines (different drive letters / usernames).
// Path assertions are built with path.join/os.homedir, not hardcoded
// separators - otherwise the test would only pass on one system.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { expandHome, normalizeProject, getProject, slugify, uniqueId } = require('../src/projects');

// ---- expandHome -------------------------------------------------------------

test('expandHome expands a bare tilde to the home directory', () => {
  assert.equal(expandHome('~'), os.homedir());
});

test('expandHome expands a tilde with a POSIX slash', () => {
  assert.equal(expandHome('~/repos/Luna-Core-HUD'), path.join(os.homedir(), 'repos/Luna-Core-HUD'));
});

test('expandHome expands a tilde with a backslash (config written on Windows)', () => {
  assert.equal(expandHome('~\\repos'), path.join(os.homedir(), 'repos'));
});

test('expandHome leaves absolute paths unchanged', () => {
  assert.equal(expandHome('/var/log'), '/var/log');
  assert.equal(expandHome('C:\\Users\\mmazur'), 'C:\\Users\\mmazur');
});

test('expandHome does NOT expand a tilde without a separator (~foo is not the home dir)', () => {
  assert.equal(expandHome('~foo'), '~foo');
});

// ---- normalizeProject -------------------------------------------------------

test('normalizeProject expands and normalizes the path', () => {
  const p = normalizeProject({ id: 'hud', label: 'HUD', path: '~/repos/Luna-Core-HUD' });
  assert.equal(p.id, 'hud');
  assert.equal(p.label, 'HUD');
  assert.equal(p.path, path.normalize(path.join(os.homedir(), 'repos/Luna-Core-HUD')));
});

test('normalizeProject rejects entries without id, label, or path', () => {
  assert.equal(normalizeProject({ label: 'X', path: '~' }), null);
  assert.equal(normalizeProject({ id: 'x', path: '~' }), null);
  assert.equal(normalizeProject({ id: 'x', label: 'X' }), null);
  assert.equal(normalizeProject({ id: 'x', label: 'X', path: '' }), null);
});

test('normalizeProject rejects non-objects', () => {
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject('~/repos'), null);
});

test('normalizeProject does not check that the directory exists (the repo may be on another machine)', () => {
  // This is a deliberate decision: a config listing a repo from another computer
  // must still load. Only safeCwd() checks the directory exists, right before the spawn.
  const p = normalizeProject({ id: 'foreign', label: 'Foreign', path: '~/i-do-not-exist-here-12345' });
  assert.notEqual(p, null);
  assert.ok(p.path.includes('i-do-not-exist-here-12345'));
});

test('normalizeProject picks the first path that exists on this machine', () => {
  const here = path.normalize(path.join(os.homedir(), 'source/repos/x'));
  const p = normalizeProject(
    { id: 'x', label: 'X', path: ['~/Desktop/repos/x', '~/source/repos/x'] },
    (d) => d === here,
  );
  assert.equal(p.path, here);
});

test("normalizeProject re-homes a path written under another user's home", () => {
  const here = path.normalize(path.join(os.homedir(), 'source/repos/x'));
  const p = normalizeProject(
    { id: 'x', label: 'X', path: 'C:\\Users\\someone-else\\source\\repos\\x' },
    (d) => d === here,
  );
  assert.equal(p.path, here);
});

test('normalizeProject keeps the first candidate when none exists here', () => {
  const p = normalizeProject({ id: 'x', label: 'X', path: ['~/a', '~/b'] }, () => false);
  assert.equal(p.path, path.normalize(path.join(os.homedir(), 'a')));
});

test('normalizeProject rejects a path list with no usable entry', () => {
  assert.equal(normalizeProject({ id: 'x', label: 'X', path: [] }), null);
  assert.equal(normalizeProject({ id: 'x', label: 'X', path: ['', 42] }), null);
});

test('getProject finds by id, otherwise null', () => {
  const list = [{ id: 'home', label: 'Home', path: '/home' }];
  assert.equal(getProject(list, 'home').label, 'Home');
  assert.equal(getProject(list, 'missing'), null);
});

// ---- slugify / uniqueId (Add Project, §"multi-repo switching") --------------

test('slugify lowercases and replaces non-alphanumerics with hyphens', () => {
  assert.equal(slugify('My Cool App'), 'my-cool-app');
  assert.equal(slugify('AMSteel_Quote'), 'amsteel-quote');
});

test('slugify trims hyphens at the edges', () => {
  assert.equal(slugify('--Foo--'), 'foo');
});

test('slugify on symbols alone does not return an empty string', () => {
  assert.equal(slugify('!!!'), 'project');
});

test('uniqueId returns the base when it is free', () => {
  assert.equal(uniqueId('hud', new Set(['other'])), 'hud');
});

test('uniqueId appends -2, -3... on collision', () => {
  assert.equal(uniqueId('hud', new Set(['hud'])), 'hud-2');
  assert.equal(uniqueId('hud', new Set(['hud', 'hud-2'])), 'hud-3');
});

// ---- rehomePath / toPortablePath (cloud-synced entries across user names) ----

const { rehomePath, toPortablePath } = require('../src/projects');

test('rehomePath re-roots a Windows path from another user onto this home', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\Kotsur69';
  assert.equal(
    rehomePath('C:\\Users\\mmazur\\source\\repos\\synthara', home),
    path.normalize(path.join(home, 'source', 'repos', 'synthara'))
  );
});

test('rehomePath handles POSIX homes and a bare home dir', () => {
  assert.equal(rehomePath('/home/alice/repos/x', '/home/bob'), path.normalize('/home/bob/repos/x'));
  assert.equal(rehomePath('/Users/alice', '/Users/bob'), path.normalize('/Users/bob'));
});

test('rehomePath returns null outside user homes or when already ours', () => {
  assert.equal(rehomePath('D:\\work\\repo', 'C:\\Users\\me'), null);
  assert.equal(rehomePath(path.join(os.homedir(), 'repos')), null);
  assert.equal(rehomePath(undefined), null);
});

test('toPortablePath collapses paths under home to ~ and leaves others alone', () => {
  const home = os.homedir();
  assert.equal(toPortablePath(home, home), '~');
  assert.equal(toPortablePath(path.join(home, 'source', 'repos', 'x'), home), `~${path.sep}${path.join('source', 'repos', 'x')}`);
  const outside = path.join(path.parse(home).root, 'elsewhere', 'repo');
  assert.equal(toPortablePath(outside, home), outside);
});

test('toPortablePath output round-trips through expandHome', () => {
  const p = path.join(os.homedir(), 'source', 'repos', 'x');
  assert.equal(path.normalize(expandHome(toPortablePath(p))), path.normalize(p));
});
