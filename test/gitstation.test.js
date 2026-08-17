// Tests for the pure half of the git station: parsing porcelain v2 and turning
// a status into the one word the panel sorts by.
//
// The number these exist to protect is BEHIND, and after it DIVERGED. A dirty
// tree you already know about - you made the mess. Two clones of one repo
// drifting apart is the failure that stays invisible until it costs an evening,
// so a parser that quietly reports 0 there is worse than one that crashes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseStatus,
  parseLastCommit,
  repoState,
  discoverRepos,
} = require('../src/gitstation.js');

const NUL = String.fromCharCode(0);

// A realistic `git status --porcelain=v2 --branch` body.
const SAMPLE = [
  '# branch.oid 0749717d',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '1 .M N... 100644 100644 100644 aaa bbb src/renderer/styles.css',
  '1 M. N... 100644 100644 100644 ccc ddd src/main.js',
  '? notes.txt',
  '? scratch/',
].join('\n');

// ---- parseStatus ------------------------------------------------------------

test('parseStatus reads branch, upstream and ahead/behind', () => {
  const s = parseStatus(SAMPLE);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
  assert.equal(s.detached, false);
});

test('parseStatus counts staged, changed and untracked separately', () => {
  const s = parseStatus(SAMPLE);
  assert.equal(s.staged, 1, 'M. is staged');
  assert.equal(s.changed, 1, '.M is unstaged');
  assert.equal(s.untracked, 2);
  assert.equal(s.conflicts, 0);
});

// A file can be staged AND further modified; the two counters overlap on purpose.
test('parseStatus counts a file that is both staged and modified in both', () => {
  const s = parseStatus('# branch.head main\n1 MM N... 100644 100644 100644 a b x.js');
  assert.equal(s.staged, 1);
  assert.equal(s.changed, 1);
});

test('parseStatus counts unmerged entries as conflicts', () => {
  const s = parseStatus('# branch.head main\nu UU N... 1 1 1 1 a b c x.js');
  assert.equal(s.conflicts, 1);
  assert.equal(s.staged, 0);
});

test('parseStatus recognises a detached HEAD', () => {
  const s = parseStatus('# branch.oid abc\n# branch.head (detached)');
  assert.equal(s.detached, true);
});

// No upstream means there is no branch.ab line at all - the answer is "unknown",
// and reporting a confident 0 would read as "in sync".
test('parseStatus leaves ahead/behind at zero when there is no upstream', () => {
  const s = parseStatus('# branch.head feature\n1 .M N... 1 1 1 a b x.js');
  assert.equal(s.upstream, '');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test('parseStatus tolerates CRLF and junk', () => {
  const s = parseStatus('# branch.head main\r\n# branch.ab +1 -0\r\n');
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 1);
  assert.deepEqual(parseStatus(null).branch, '');
  assert.deepEqual(parseStatus('').branch, '');
});

// ---- parseLastCommit --------------------------------------------------------

test('parseLastCommit reads the NUL-separated format', () => {
  const out = parseLastCommit(['0749717', '1755388800', 'feat: panels'].join(NUL));
  assert.equal(out.hash, '0749717');
  assert.equal(out.at, 1755388800 * 1000);
  assert.equal(out.subject, 'feat: panels');
});

// The reason the separator is NUL and not a space or a pipe.
test('parseLastCommit keeps a subject that contains delimiters', () => {
  const subject = 'fix: handle a | b and 1 2 3 spacing';
  const out = parseLastCommit(['abc1234', '1755388800', subject].join(NUL));
  assert.equal(out.subject, subject);
});

test('parseLastCommit returns null for a repo with no commits', () => {
  assert.equal(parseLastCommit(''), null);
  assert.equal(parseLastCommit('\n'), null);
  assert.equal(parseLastCommit(null), null);
});

// ---- repoState --------------------------------------------------------------

const status = (over) => ({
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  changed: 0,
  untracked: 0,
  conflicts: 0,
  detached: false,
  ...over,
});

test('repoState ranks a conflict above everything else', () => {
  assert.equal(repoState(status({ conflicts: 1, behind: 9, changed: 4 })), 'conflict');
});

// The two-machine trap gets its own word, not "ahead" or "behind".
test('repoState names divergence when both directions are non-zero', () => {
  assert.equal(repoState(status({ ahead: 2, behind: 3 })), 'diverged');
});

test('repoState reports behind before ahead', () => {
  assert.equal(repoState(status({ behind: 4 })), 'behind');
  assert.equal(repoState(status({ ahead: 4 })), 'ahead');
});

test('repoState reports a dirty tree only once sync is settled', () => {
  assert.equal(repoState(status({ changed: 3 })), 'dirty');
  assert.equal(repoState(status({ untracked: 1 })), 'dirty');
  assert.equal(repoState(status({ behind: 1, changed: 3 })), 'behind');
});

// A branch with nowhere to push is not "clean" - it is a repo whose ahead/behind
// nobody can compute, which is exactly the state that hides divergence.
test('repoState flags a branch with no upstream', () => {
  assert.equal(repoState(status({ upstream: '' })), 'noUpstream');
  assert.equal(repoState(status({ upstream: '', detached: true })), 'clean');
});

test('repoState reports clean when there is nothing to say', () => {
  assert.equal(repoState(status()), 'clean');
  assert.equal(repoState(null), 'unknown');
});

// ---- discoverRepos ----------------------------------------------------------

test('discoverRepos finds repos and stops descending into them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-git-'));
  try {
    // root/alpha/.git  and  root/nested/beta/.git - one level and two.
    fs.mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested', 'beta', '.git'), { recursive: true });
    // A repo inside a repo must not be reported twice.
    fs.mkdirSync(path.join(root, 'alpha', 'vendor', '.git'), { recursive: true });

    const found = discoverRepos([root], 2);
    assert.ok(found.includes(path.join(root, 'alpha')));
    assert.ok(found.includes(path.join(root, 'nested', 'beta')));
    assert.equal(found.includes(path.join(root, 'alpha', 'vendor')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverRepos skips node_modules and dot directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-git-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cache', 'x', '.git'), { recursive: true });
    assert.deepEqual(discoverRepos([root], 2), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverRepos ignores a root that is not on this machine', () => {
  assert.deepEqual(discoverRepos([path.join(os.tmpdir(), 'definitely-not-here-9f3a')], 2), []);
  assert.deepEqual(discoverRepos([], 2), []);
});
