// ============================================================================
// Luna's Work on Unity: where the UnityYAMLMerge attributes live
// (src/lunasworkScene.js configureUnityMerge) against real temp git repos.
// Covers: the block goes to the common git dir's info/attributes and git
// reads it inside a linked worktree (the builders' worktrees); the tracked
// .gitattributes is never written, so the checkout stays clean; a block an
// earlier LunaCore left uncommitted in .gitattributes is taken out (the file
// is restored, or deleted when LunaCore made it); a committed block is kept.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const Scene = require('../src/lunasworkScene');

// A plain path with no quoting characters: the driver is only configured, never run.
const MERGE_TOOL = path.join(os.tmpdir(), 'UnityYAMLMerge.exe');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const status = (repo) => git(repo, 'status', '--porcelain', '--untracked-files=all');

function makeRepo(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-attr-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  const repo = path.join(root, 'game');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Luna Test');
  git(repo, 'config', 'user.email', 'luna@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [rel, text] of Object.entries({ 'Assets/Main.unity': '%YAML 1.1\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return { root, repo };
}

const mergeAttr = (cwd) => git(cwd, 'check-attr', 'merge', '--', 'Assets/Main.unity');

test('the block goes to info/attributes, a linked worktree reads it, and the checkout stays clean', async (t) => {
  const { root, repo } = makeRepo(t);
  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.driver, true);
  assert.equal('legacyBlock' in res, false);

  assert.equal(status(repo), '', 'nothing tracked or untracked changed');
  assert.equal(fs.existsSync(path.join(repo, '.gitattributes')), false);
  assert.equal(mergeAttr(repo), 'Assets/Main.unity: merge: unityyamlmerge');

  // A builder's worktree, made after the configuration, sees the same attribute.
  const wt = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'luna/pkg-abcde', wt);
  assert.equal(mergeAttr(wt), 'Assets/Main.unity: merge: unityyamlmerge');
  assert.equal(git(wt, 'config', '--get', 'merge.unityyamlmerge.recursive'), 'binary');
  assert.equal(status(wt), '');

  // Configured from inside the worktree: still the common dir, still nothing tracked.
  const again = await Scene.configureUnityMerge(wt, { mergeTool: MERGE_TOOL });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(status(wt), '');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'worktrees', 'wt', 'info', 'attributes')), false);
});

test('an uncommitted LunaCore block in a tracked .gitattributes is taken out and the file restored', async (t) => {
  const own = '* text=auto\r\n*.png binary\r\n';
  const { repo } = makeRepo(t, { '.gitattributes': own });
  // What an earlier LunaCore left: the block appended (and the line endings normalized).
  fs.writeFileSync(path.join(repo, '.gitattributes'), Scene.withAttributesBlock(own));
  assert.equal(status(repo), 'M .gitattributes');

  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.legacyBlock, 'removed');
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), own, 'byte for byte, CRLF included');
  assert.equal(status(repo), '');
  assert.equal(mergeAttr(repo), 'Assets/Main.unity: merge: unityyamlmerge', 'info/attributes carries it now');
});

test("Mati's own uncommitted rules stay when the block is taken out", async (t) => {
  const { repo } = makeRepo(t, { '.gitattributes': '* text=auto\n' });
  fs.writeFileSync(path.join(repo, '.gitattributes'), Scene.withAttributesBlock('* text=auto\n*.psd binary\n'));

  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL });
  assert.equal(res.legacyBlock, 'removed');
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), '* text=auto\n*.psd binary\n');
});

test('a .gitattributes only LunaCore made (never committed) is deleted', async (t) => {
  const { repo } = makeRepo(t);
  fs.writeFileSync(path.join(repo, '.gitattributes'), Scene.withAttributesBlock(''));
  assert.equal(status(repo), '?? .gitattributes');

  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL });
  assert.equal(res.legacyBlock, 'removed');
  assert.equal(fs.existsSync(path.join(repo, '.gitattributes')), false);
  assert.equal(status(repo), '');
});

test('a committed block is part of the history and is left alone', async (t) => {
  const committed = Scene.withAttributesBlock('* text=auto\n');
  const { repo } = makeRepo(t, { '.gitattributes': committed });

  const res = await Scene.configureUnityMerge(repo, { mergeTool: MERGE_TOOL });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.legacyBlock, 'kept');
  assert.equal(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), committed);
  assert.equal(status(repo), '');
});

test('withoutAttributesBlock undoes withAttributesBlock', () => {
  for (const text of ['', '* text=auto\n', '* text=auto\n*.png binary\n']) {
    assert.equal(Scene.withoutAttributesBlock(Scene.withAttributesBlock(text)), text);
  }
  const middle = `a\n\n${Scene.withAttributesBlock('').trim()}\n\nb\n`;
  assert.equal(Scene.withoutAttributesBlock(middle), 'a\nb\n');
  assert.equal(Scene.withoutAttributesBlock('no block\n'), 'no block\n');
});
