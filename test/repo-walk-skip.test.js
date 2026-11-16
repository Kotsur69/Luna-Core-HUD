// ============================================================================
// LunaCore - repo walkers never enter build output or an .asar
// (src/repoWalkSkip.js and the walkers that use it)
//
// Under Electron any fs call on a *.asar path opens the archive and keeps it
// open for the life of the process; that lock made `npm run dist` fail with
// EBUSY on dist/win-unpacked/resources/app.asar. Plain node has no asar
// support, so here an "app.asar" is a real folder: a walker that lists a file
// inside it has walked into it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { shouldSkipEntry, isAsarName, BUILD_OUTPUT_DIRS } = require('../src/repoWalkSkip.js');
const { findDraftFiles, LEGAL_DRAFT_MARKER } = require('../src/lunasworkLegal.js');
const { discoverRepos } = require('../src/gitstation.js');
const { treeLines } = require('../src/lunasyncfingerprint.js');
const { detectLayout } = require('../src/lunasworkI18n.js');

const SKIPPED_DIRS = ['dist', 'out', 'release', 'Dist'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-walk-skip-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const put = (rel, text = '') => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, put };
}

test('shouldSkipEntry: build output folders and every .asar entry, nothing else', () => {
  assert.deepEqual([...BUILD_OUTPUT_DIRS], ['dist', 'out', 'release']);
  for (const dir of SKIPPED_DIRS) assert.equal(shouldSkipEntry(dir, true), true, dir);
  for (const name of ['app.asar', 'default_app.asar', 'APP.ASAR', 'app.asar.unpacked']) {
    assert.equal(shouldSkipEntry(name, false), true, `${name} as a file`);
    assert.equal(shouldSkipEntry(name, true), true, `${name} as a folder (Electron says asar is a folder)`);
    assert.equal(isAsarName(name), true, name);
  }
  // A FILE called dist / release is not build output.
  for (const name of ['dist', 'release', 'out']) assert.equal(shouldSkipEntry(name, false), false, name);
  for (const name of ['src', 'distribution', 'releases.md', 'outline', 'asar', 'my.asar.txt', 'README.md']) {
    assert.equal(shouldSkipEntry(name, true), false, name);
    assert.equal(shouldSkipEntry(name, false), false, name);
  }
  assert.equal(isAsarName('notes.md'), false);
  assert.equal(isAsarName(null), false);
  assert.equal(shouldSkipEntry('', true), true, 'a nameless entry is never walked');
  assert.equal(shouldSkipEntry(undefined, false), true);
});

test('lunasworkLegal.findDraftFiles: no drafts from dist/, out/, release/ or inside an .asar', (t) => {
  const { root, put } = fixture(t);
  const marked = `<!-- ${LEGAL_DRAFT_MARKER} -->\n`;
  put('src/privacy.md', marked);
  for (const dir of SKIPPED_DIRS) put(`${dir}/privacy.md`, marked);
  put('pkg/dist/win-unpacked/resources/app.asar/terms.md', marked);
  put('pkg/resources/app.asar/terms.md', marked);
  put('pkg/notes.asar', marked);
  assert.deepEqual(findDraftFiles(root), ['src/privacy.md']);
});

test('gitstation.discoverRepos: never walks into build output or an .asar', (t) => {
  const { root, put } = fixture(t);
  put('apps/kept/.git/HEAD', 'ref: refs/heads/main\n');
  for (const dir of SKIPPED_DIRS) put(`apps/${dir}/hidden/.git/HEAD`, 'x');
  put('apps/app.asar/hidden/.git/HEAD', 'x');
  assert.deepEqual(discoverRepos([root], 4), [path.join(root, 'apps', 'kept')]);
});

test('gitstation.discoverRepos: a real repo checked out as release/ is still found; an .asar repo never', (t) => {
  const { root, put } = fixture(t);
  put('release/.git/HEAD', 'ref: refs/heads/main\n');
  put('tools.asar/.git/HEAD', 'x');
  assert.deepEqual(discoverRepos([root], 3), [path.join(root, 'release')]);
});

test('lunasyncfingerprint.treeLines: .asar entries skipped, a folder named release still read', (t) => {
  const { root, put } = fixture(t);
  put('rules/release/notes.md', 'kept');
  put('rules/app.asar/inside.md', 'never');
  put('rules/single.asar', 'never');
  const files = treeLines(path.join(root, 'rules')).map((line) => path.relative(root, line.split('|')[0]).split(path.sep).join('/'));
  assert.deepEqual(files, ['rules/release/notes.md']);
});

test('lunasworkI18n.detectLayout: a pl/en map under dist/ or inside an .asar is not the source', (t) => {
  const map = "export const strings = { pl: { hello: 'Czesc' }, en: { hello: 'Hello' } };\n";
  const built = fixture(t);
  for (const dir of SKIPPED_DIRS) built.put(`${dir}/i18n.js`, map);
  built.put('pkg/app.asar/i18n.js', map);
  assert.equal(detectLayout(built.root), null, 'only build output holds a map: no layout');

  const source = fixture(t);
  const file = source.put('src/i18n.js', map);
  source.put('dist/i18n.js', map);
  const layout = detectLayout(source.root);
  assert.ok(layout, 'the source map is found');
  assert.deepEqual(layout.files.pl, [file]);
});
