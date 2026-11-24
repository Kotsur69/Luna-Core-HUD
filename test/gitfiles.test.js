// Tests for the pure functions behind the git-sourced Active-Files signal
// (src/gitfiles.js). This module exists because 111 Bash + 16 PowerShell
// calls in a real transcript produced two Write-tool rows and nothing else,
// while `git status` in the same repo showed four real changed files -
// Bash/PowerShell carry no `file_path`, so the transcript path never sees
// them. The IO half (execFile, fs reads) is left to manual checks, same split
// gitstation.js and filestat.js already use.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseChangedPaths, parseNumstat, readUntrackedLineCount, pathInsideCwd, realPathInsideCwd } = require('../src/gitfiles.js');
const fs = require('node:fs');
const os = require('node:os');

const NUL = '\0';

// ---- parseChangedPaths -------------------------------------------------------

test('parseChangedPaths reads an ordinary changed (tracked) entry', () => {
  const stdout = ['1 .M N... 100644 100644 100644 aaa bbb src/main.js', ''].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [{ path: 'src/main.js', untracked: false }]);
});

test('parseChangedPaths reads an untracked entry', () => {
  const stdout = ['? config/new.py', ''].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [{ path: 'config/new.py', untracked: true }]);
});

test('parseChangedPaths reads a rename/copy entry and skips the paired origPath token', () => {
  // Record '2' is followed by a SEPARATE NUL-terminated origPath token - the
  // whole reason this module asks for -z instead of the default quoting.
  const stdout = [
    '2 R100 N... 100644 100644 100644 aaa bbb R100 src/new-name.js',
    'src/old-name.js',
    '? untracked-after.txt',
    '',
  ].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [
    { path: 'src/new-name.js', untracked: false },
    { path: 'untracked-after.txt', untracked: true },
  ]);
});

test('parseChangedPaths reads an unmerged/conflict entry', () => {
  const stdout = ['u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.js', ''].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [{ path: 'src/conflict.js', untracked: false }]);
});

test('parseChangedPaths keeps a path with spaces intact', () => {
  const stdout = ['1 .M N... 100644 100644 100644 aaa bbb my notes.md', ''].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [{ path: 'my notes.md', untracked: false }]);
});

test('parseChangedPaths ignores branch header records', () => {
  const stdout = ['# branch.head main', '# branch.ab +0 -0', '? a.txt', ''].join(NUL);
  const rows = parseChangedPaths(stdout);
  assert.deepEqual(rows, [{ path: 'a.txt', untracked: true }]);
});

test('parseChangedPaths on empty/missing input returns an empty array', () => {
  assert.deepEqual(parseChangedPaths(''), []);
  assert.deepEqual(parseChangedPaths(undefined), []);
  assert.deepEqual(parseChangedPaths(null), []);
});

// ---- parseNumstat -------------------------------------------------------------

test('parseNumstat reads added/removed counts per file', () => {
  const stdout = '12\t3\tsrc/main.js\n0\t7\tsrc/observer.js\n';
  assert.deepEqual(parseNumstat(stdout), [
    { path: 'src/main.js', added: 12, removed: 3 },
    { path: 'src/observer.js', added: 0, removed: 7 },
  ]);
});

test('parseNumstat treats a binary file (-\\t-\\tpath) as {0,0} rather than throwing', () => {
  const stdout = '-\t-\tassets/icon.png\n';
  assert.deepEqual(parseNumstat(stdout), [{ path: 'assets/icon.png', added: 0, removed: 0 }]);
});

test('parseNumstat keeps a path with spaces intact', () => {
  const stdout = '5\t1\tmy notes.md\n';
  assert.deepEqual(parseNumstat(stdout), [{ path: 'my notes.md', added: 5, removed: 1 }]);
});

test('parseNumstat on empty/missing input returns an empty array', () => {
  assert.deepEqual(parseNumstat(''), []);
  assert.deepEqual(parseNumstat(undefined), []);
});

// ---- readUntrackedLineCount ---------------------------------------------------

test('readUntrackedLineCount returns 0 for a path that does not exist', () => {
  assert.equal(readUntrackedLineCount('Z:\\nope\\does-not-exist.txt'), 0);
});

// ---- pathInsideCwd (the files:diff containment guard) -----------------------
// `file` is renderer-supplied, so the diff handler must refuse anything that
// resolves outside the session's own cwd. The guard returns the repo-relative
// path when inside, null otherwise.

const CWD = path.resolve('/repo/project');

test('pathInsideCwd accepts a plain relative file inside cwd', () => {
  assert.equal(pathInsideCwd(CWD, 'src/main.js'), path.join('src', 'main.js'));
});

test('pathInsideCwd accepts an absolute path that resolves inside cwd', () => {
  assert.equal(pathInsideCwd(CWD, path.join(CWD, 'src', 'main.js')), path.join('src', 'main.js'));
});

test('pathInsideCwd rejects a ../ escape', () => {
  assert.equal(pathInsideCwd(CWD, '../secret.txt'), null);
  assert.equal(pathInsideCwd(CWD, '../../etc/hosts'), null);
});

test('pathInsideCwd rejects an absolute path outside cwd', () => {
  assert.equal(pathInsideCwd(CWD, path.resolve('/etc/passwd')), null);
});

test('pathInsideCwd rejects cwd itself (no file to diff)', () => {
  assert.equal(pathInsideCwd(CWD, '.'), null);
});

test('pathInsideCwd rejects empty or missing arguments', () => {
  assert.equal(pathInsideCwd('', 'x'), null);
  assert.equal(pathInsideCwd(CWD, ''), null);
  assert.equal(pathInsideCwd(CWD, undefined), null);
  assert.equal(pathInsideCwd(undefined, 'x'), null);
});

// ---- realPathInsideCwd (symlink-aware half of the files:diff guard) ----------
// pathInsideCwd() is lexical, so a symlink inside the repo that points outside
// passes it. These run against a real temp dir; a symlink that cannot be made
// (Windows without developer mode: EPERM) skips its test instead of failing.

/** A temp repo dir and a sibling "outside" dir holding secret.txt; removed after the test. */
function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-realpath-'));
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, 'src', 'main.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const links = [];
  t.after(async () => {
    // Links first: a recursive remove must never walk through one into its target.
    for (const link of links) fs.rmSync(link, { force: true, recursive: false });
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  /** Makes a link, or returns false (and skips the test) when this system cannot. */
  const link = (target, at, type) => {
    try {
      fs.symlinkSync(target, at, type);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      t.skip(`cannot create a symlink here (${err.code})`);
      return false;
    }
    links.push(at);
    return true;
  };
  return { repo, outside, link };
}

test('realPathInsideCwd accepts a real file inside cwd', async (t) => {
  const { repo } = makeSandbox(t);
  assert.equal(await realPathInsideCwd(repo, 'src/main.js'), true);
  assert.equal(await realPathInsideCwd(repo, path.join(repo, 'src', 'main.js')), true);
});

test('realPathInsideCwd still accepts a deleted file inside cwd (it diffs against HEAD)', async (t) => {
  const { repo } = makeSandbox(t);
  fs.rmSync(path.join(repo, 'src', 'main.js'));
  assert.equal(await realPathInsideCwd(repo, 'src/main.js'), true);
  assert.equal(await realPathInsideCwd(repo, 'gone/dir/file.js'), true, 'a deleted folder too');
});

test('realPathInsideCwd keeps refusing what the lexical check refuses', async (t) => {
  const { repo } = makeSandbox(t);
  assert.equal(await realPathInsideCwd(repo, '../outside/secret.txt'), false);
  assert.equal(await realPathInsideCwd(repo, '.'), false);
  assert.equal(await realPathInsideCwd(repo, ''), false);
});

test('realPathInsideCwd refuses a file symlink inside cwd that points outside', async (t) => {
  const { repo, outside, link } = makeSandbox(t);
  if (!link(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'), 'file')) return;
  assert.equal(pathInsideCwd(repo, 'leak.txt'), 'leak.txt', 'the lexical check alone lets it through');
  assert.equal(await realPathInsideCwd(repo, 'leak.txt'), false);
});

test('realPathInsideCwd refuses a path through a linked folder that points outside, existing or not', async (t) => {
  const { repo, outside, link } = makeSandbox(t);
  // A junction needs no privilege on Windows; elsewhere the type is ignored.
  if (!link(outside, path.join(repo, 'linked'), 'junction')) return;
  assert.equal(await realPathInsideCwd(repo, 'linked/secret.txt'), false);
  assert.equal(await realPathInsideCwd(repo, 'linked/missing.txt'), false, 'judged by its nearest existing folder');
});

test('realPathInsideCwd accepts a symlink that stays inside cwd', async (t) => {
  const { repo, link } = makeSandbox(t);
  if (!link(path.join(repo, 'src', 'main.js'), path.join(repo, 'alias.js'), 'file')) return;
  assert.equal(await realPathInsideCwd(repo, 'alias.js'), true);
});

test('realPathInsideCwd refuses a path through a link whose target does not exist yet', async (t) => {
  const { repo, outside, link } = makeSandbox(t);
  // The target could be created between the check and git's read.
  if (!link(path.join(outside, 'not-yet'), path.join(repo, 'dangling'), 'junction')) return;
  assert.equal(await realPathInsideCwd(repo, 'dangling/file.txt'), false);
  assert.equal(await realPathInsideCwd(repo, 'dangling'), false);
});
