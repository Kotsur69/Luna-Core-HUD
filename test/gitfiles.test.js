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

const { parseChangedPaths, parseNumstat, readUntrackedLineCount } = require('../src/gitfiles.js');

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
