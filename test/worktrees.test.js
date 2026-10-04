// Tests for src/worktrees.js - the "New tab in worktree" plumbing
// (ORCHESTRATOR_PLAN.md slice 1). Pure helpers first, then real temp git
// repos for addWorktree, since the whole point is what git actually does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  slugify,
  worktreePathFor,
  branchFor,
  copyEnvFiles,
  addWorktree,
  WORKTREE_DIR,
  MAX_SLUG_CHARS,
} = require('../src/worktrees.js');

// ---- pure helpers -----------------------------------------------------------

test('slugify keeps a-z, 0-9 and single dashes', () => {
  assert.equal(slugify('Fix Login Bug!'), 'fix-login-bug');
  assert.equal(slugify('  feat/../x.lock  '), 'feat-x-lock');
  assert.equal(slugify('ąę zażółć'), 'za');
});

test('slugify rejects empty and non-string input', () => {
  assert.equal(slugify(''), null);
  assert.equal(slugify('!!!'), null);
  assert.equal(slugify(undefined), null);
  assert.equal(slugify(42), null);
});

test('slugify caps the length without a trailing dash', () => {
  const slug = slugify(`${'a'.repeat(MAX_SLUG_CHARS - 1)} bbb`);
  assert.equal(slug, 'a'.repeat(MAX_SLUG_CHARS - 1));
});

test('worktreePathFor sits beside the repo, namespaced by repo name', () => {
  const root = path.join(path.sep, 'repos', 'app');
  assert.equal(worktreePathFor(root, 'x'), path.join(path.sep, 'repos', WORKTREE_DIR, 'app', 'x'));
  assert.equal(branchFor('x'), 'luna/x');
});

test('copyEnvFiles copies only missing top-level .env files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-env-'));
  const from = path.join(tmp, 'from');
  const to = path.join(tmp, 'to');
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(from, '.env'), 'A=1');
  fs.writeFileSync(path.join(from, '.env.local'), 'B=2');
  fs.writeFileSync(path.join(from, '.env.example'), 'from');
  fs.writeFileSync(path.join(to, '.env.example'), 'tracked');
  fs.writeFileSync(path.join(from, '.envrc'), 'no');
  fs.writeFileSync(path.join(from, 'README.md'), 'no');

  assert.equal(copyEnvFiles(from, to), 2);
  assert.deepEqual(fs.readdirSync(to).sort(), ['.env', '.env.example', '.env.local']);
  assert.equal(fs.readFileSync(path.join(to, '.env.example'), 'utf8'), 'tracked');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- addWorktree against real git -------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A temp parent with a repo `app` inside; returns both paths. */
function makeRepo({ commit = true } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-wt-')));
  const repo = path.join(parent, 'app');
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'luna@test');
  git(repo, 'config', 'user.name', 'Luna');
  fs.writeFileSync(path.join(repo, 'pkg', 'index.js'), '1');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  if (commit) {
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  }
  return { parent, repo, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

test('addWorktree creates branch + checkout beside the repo', async () => {
  const { parent, repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');

    const res = await addWorktree(repo, 'Fix Login');
    assert.equal(res.ok, true, JSON.stringify(res));
    const expected = path.join(parent, WORKTREE_DIR, 'app', 'fix-login');
    assert.equal(res.root, expected);
    assert.equal(res.cwd, expected);
    assert.equal(res.branch, 'luna/fix-login');
    assert.equal(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD'), 'luna/fix-login');
    assert.equal(fs.readFileSync(path.join(expected, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(res.envCopied, 1);
    assert.equal(fs.existsSync(path.join(expected, 'node_modules')), false);
    // The main checkout is untouched: still on its own branch, still clean.
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    cleanup();
  }
});

test('addWorktree opens the same sub-folder inside the worktree', async () => {
  const { parent, repo, cleanup } = makeRepo();
  try {
    const res = await addWorktree(path.join(repo, 'pkg'), 'sub');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.cwd, path.join(parent, WORKTREE_DIR, 'app', 'sub', 'pkg'));
  } finally {
    cleanup();
  }
});

test('addWorktree refuses a name that is already taken', async () => {
  const { repo, cleanup } = makeRepo();
  try {
    assert.equal((await addWorktree(repo, 'twice')).ok, true);
    const again = await addWorktree(repo, 'twice');
    assert.equal(again.ok, false);
    assert.equal(again.error, 'exists');
  } finally {
    cleanup();
  }
});

test('addWorktree reports a branch git refuses as gitFailed', async () => {
  const { repo, cleanup } = makeRepo();
  try {
    git(repo, 'branch', 'luna/taken');
    const res = await addWorktree(repo, 'taken');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'gitFailed');
    assert.match(res.detail, /taken/);
  } finally {
    cleanup();
  }
});

test('addWorktree errors: bad name, not a repo, no commits', async () => {
  const { parent, repo, cleanup } = makeRepo({ commit: false });
  try {
    assert.equal((await addWorktree(repo, '???')).error, 'badName');
    const plain = path.join(parent, 'plain');
    fs.mkdirSync(plain);
    // A temp dir can still sit inside some repo on a dev machine; only assert
    // notRepo when git agrees there is none.
    const res = await addWorktree(plain, 'x');
    if (res.error !== 'noCommits') assert.equal(res.error, 'notRepo');
    assert.equal((await addWorktree(repo, 'x')).error, 'noCommits');
  } finally {
    cleanup();
  }
});
