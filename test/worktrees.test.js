// Tests for src/worktrees.js - the "New tab in worktree" plumbing
// (ORCHESTRATOR_PLAN.md slice 1). Pure helpers first, then real temp git
// repos for addWorktree, since the whole point is what git actually does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const {
  slugify,
  worktreePathFor,
  branchFor,
  copyEnvFiles,
  addWorktree,
  removeWorktree,
  runGit,
  gitDetail,
  headFailureReason,
  gitError,
  WORKTREE_DIR,
  MAX_SLUG_CHARS,
  GIT_TIMEOUT_MS,
  REMOVE_TIMEOUT_MS,
} = require('../src/worktrees.js');

// ---- rev-parse failure classification (fake git) ------------------------------

/** A fake execFile whose first call (rev-parse --show-toplevel) fails with `err`. */
function failingTopLevel(err, stderr = '') {
  return (cmd, args, opts, cb) => cb(err, '', stderr);
}

test('addWorktree: git saying "not a git repository" is notRepo, with a detail', async () => {
  const err = Object.assign(new Error('Command failed'), { code: 128 });
  const res = await addWorktree('C:\\nowhere', 'x', {
    execImpl: failingTopLevel(err, 'fatal: not a git repository (or any of the parent directories): .git\n'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'notRepo');
  assert.match(res.detail, /git rev-parse --show-toplevel/, 'names the command');
  assert.match(res.detail, /C:\\nowhere/, 'names the folder checked');
  assert.match(res.detail, /exit 128, not timed out/);
  assert.match(res.detail, /not a git repository/, 'carries the stderr tail');
});

test('addWorktree: any other rev-parse failure is gitFailed, not notRepo', async () => {
  const err = Object.assign(new Error('Command failed'), { code: 128 });
  const res = await addWorktree('C:\\repo', 'x', {
    execImpl: failingTopLevel(err, "fatal: detected dubious ownership in repository at 'C:/repo'\n"),
  });
  assert.equal(res.error, 'gitFailed');
  assert.equal(res.retryable, true);
  assert.match(res.detail, /exit 128.*dubious ownership/);
});

test('addWorktree: a git timeout is gitFailed with a reason, not notRepo', async () => {
  const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
  const res = await addWorktree('C:\\repo', 'x', { execImpl: failingTopLevel(err) });
  assert.equal(res.error, 'gitFailed');
  assert.equal(res.retryable, true, 'God Mode retries it');
  assert.match(res.detail, /timed out after 30s/);
  assert.match(res.detail, /git rev-parse --show-toplevel in C:\\repo/);
});

test('addWorktree: a timeout on the HEAD check is gitFailed, not noCommits', async () => {
  let n = 0;
  const execImpl = (cmd, args, opts, cb) => {
    n += 1;
    if (n === 1) return cb(null, 'C:/repo\n', '');
    return cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
  };
  const res = await addWorktree('C:\\repo', 'x', { execImpl });
  assert.equal(res.error, 'gitFailed');
  assert.match(res.detail, /rev-parse --verify HEAD.*timed out/);
});

test('runGit reports exit code, timeout and the limit it used', async () => {
  const seen = [];
  const execImpl = (cmd, args, opts, cb) => {
    seen.push(opts.timeout);
    cb(Object.assign(new Error('x'), { code: 1 }), '', 'error: boom\n');
  };
  const res = await runGit('/r', ['status'], execImpl, { timeoutMs: 1234 });
  assert.deepEqual([res.ok, res.code, res.timedOut, res.timeoutMs], [false, 1, false, 1234]);
  assert.deepEqual(seen, [1234]);
  assert.match(gitDetail(res), /^git status in \/r: exit 1, not timed out; stderr: error: boom$/);
});

test('headFailureReason: notRepo only when git says so', () => {
  assert.equal(headFailureReason({ broke: '', stderr: 'fatal: not a git repository' }), 'notRepo');
  assert.equal(headFailureReason({ broke: '', stderr: 'fatal: Needed a single revision' }), 'noCommits');
  assert.equal(headFailureReason({ broke: 'git timed out after 30s', stderr: '' }), 'gitFailed');
  assert.equal(headFailureReason({ broke: '', stderr: 'fatal: something else' }), 'gitFailed');
});

// ---- removeWorktree: links first, truthful failures ----------------------------

/** Fake git for removeWorktree: clean status, the remove answered by `remove`. */
function removeGit(remove = () => [null, '', '']) {
  const calls = [];
  const execImpl = (cmd, args, opts, cb) => {
    calls.push({ args: args.slice(2), timeout: opts.timeout });
    if (args[2] === 'status') return cb(null, '', '');
    return cb(...remove());
  };
  return { execImpl, calls };
}

/** Fake fs where `<root>/node_modules` is a link that cannot be unlinked. */
function stuckLinkFs(root) {
  const link = path.join(root, 'node_modules');
  const denied = () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
  return {
    lstatSync: (p) => {
      if (p === link) return { isSymbolicLink: () => true, isDirectory: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdirSync: () => [],
    unlinkSync: denied,
    rmdirSync: denied,
  };
}

test('removeWorktree: a link that cannot be unlinked stops removal before git removes anything', async () => {
  const root = path.resolve('/wt/a');
  const git = removeGit();
  const res = await removeWorktree('/r', root, { execImpl: git.execImpl, fsImpl: stuckLinkFs(root) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'linkRemoveFailed');
  assert.match(res.detail, /node_modules/);
  assert.match(res.detail, /EPERM/);
  assert.ok(!git.calls.some((c) => c.args[0] === 'worktree'), 'git worktree remove never ran');
});

test('removeWorktree: a removal timeout says so, with the longer removal limit', async () => {
  const git = removeGit(() => [Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM', code: null }), '', '']);
  const res = await removeWorktree('/r', '/wt/missing-folder', { execImpl: git.execImpl });
  assert.equal(res.error, 'gitFailed');
  assert.match(res.detail, new RegExp(`timed out after ${REMOVE_TIMEOUT_MS / 1000}s`));
  assert.match(res.detail, /git worktree remove -- \/wt\/missing-folder/);
  const remove = git.calls.find((c) => c.args[0] === 'worktree');
  assert.equal(remove.timeout, REMOVE_TIMEOUT_MS);
  assert.ok(REMOVE_TIMEOUT_MS > GIT_TIMEOUT_MS);
});

test('removeWorktree: a git refusal carries its fatal line and exit code', async () => {
  const git = removeGit(() => [Object.assign(new Error('x'), { code: 128 }), '', "fatal: '/wt/x' is not a working tree\n"]);
  const res = await removeWorktree('/r', '/wt/x', { execImpl: git.execImpl });
  assert.equal(res.error, 'gitFailed');
  assert.match(res.detail, /^fatal: '\/wt\/x' is not a working tree \(git worktree remove .*exit 128/);
});

test('addWorktree: git failing to start is gitFailed with the spawn code', async () => {
  const err = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const res = await addWorktree('C:\\repo', 'x', { execImpl: failingTopLevel(err) });
  assert.equal(res.error, 'gitFailed');
  assert.match(res.detail, /ENOENT/);
});

// ---- pure helpers -----------------------------------------------------------

test('gitError picks the fatal/error line over git progress output', () => {
  const stderr = "Preparing worktree (new branch 'luna/x-integration')\nfatal: a branch named 'luna/x-integration' already exists\n";
  assert.equal(gitError(stderr), "fatal: a branch named 'luna/x-integration' already exists");
  assert.equal(gitError('error: pathspec x\n'), 'error: pathspec x');
  assert.equal(gitError('just one line'), 'just one line');
  assert.equal(gitError(''), '');
});

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

// Real git with no kill timer. addWorktree's own 30s GIT_TIMEOUT_MS is a
// production guard against a hung git; on a loaded machine (several suites
// running at once) `git worktree add` alone has taken longer than that, and a
// killed git surfaces as gitFailed with an empty detail - a flake, not a bug.
const PATIENT = {
  execImpl: (cmd, args, opts, cb) => execFile(cmd, args, { ...opts, timeout: 0 }, cb),
};

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

    const res = await addWorktree(repo, 'Fix Login', PATIENT);
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
    const res = await addWorktree(path.join(repo, 'pkg'), 'sub', PATIENT);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.cwd, path.join(parent, WORKTREE_DIR, 'app', 'sub', 'pkg'));
  } finally {
    cleanup();
  }
});

test('addWorktree refuses a name that is already taken', async () => {
  const { repo, cleanup } = makeRepo();
  try {
    assert.equal((await addWorktree(repo, 'twice', PATIENT)).ok, true);
    const again = await addWorktree(repo, 'twice', PATIENT);
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
    const res = await addWorktree(repo, 'taken', PATIENT);
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
    assert.equal((await addWorktree(repo, '???', PATIENT)).error, 'badName');
    const plain = path.join(parent, 'plain');
    fs.mkdirSync(plain);
    // A temp dir can still sit inside some repo on a dev machine; only assert
    // notRepo when git agrees there is none.
    const res = await addWorktree(plain, 'x', PATIENT);
    if (res.error !== 'noCommits') assert.equal(res.error, 'notRepo');
    assert.equal((await addWorktree(repo, 'x', PATIENT)).error, 'noCommits');
  } finally {
    cleanup();
  }
});

/** Awaited, retried delete: a git just exited may still hold a handle (Windows). */
const removeTree = (dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

test('addWorktree: a real folder outside any repo is notRepo with a detail', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-norepo-')));
  const plain = path.join(parent, 'plain');
  fs.mkdirSync(plain);
  // GIT_CEILING_DIRECTORIES: git never looks above `parent`, so a temp dir
  // inside some repo on a dev machine still reads as no repo.
  const execImpl = (cmd, args, opts, cb) =>
    execFile(cmd, args, { ...opts, timeout: 0, env: { ...process.env, GIT_CEILING_DIRECTORIES: parent } }, cb);
  try {
    const res = await addWorktree(plain, 'x', { execImpl });
    assert.equal(res.error, 'notRepo', JSON.stringify(res));
    assert.ok(res.detail, 'never a null detail');
    assert.ok(res.detail.includes(plain), 'names the folder checked');
    assert.match(res.detail, /exit 128, not timed out; stderr: .*not a git repository/);
  } finally {
    await removeTree(parent);
  }
});

const junctionTest = process.platform === 'win32' ? test : test.skip;

junctionTest('removeWorktree: REAL junctions are unlinked first - their targets keep every file', async () => {
  const { parent, repo } = makeRepo();
  const shared = path.join(parent, 'main-node_modules');
  const sharedSub = path.join(parent, 'main-pkg-node_modules');
  const links = [];
  try {
    fs.mkdirSync(path.join(shared, 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'left-pad', 'index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(shared, '.package-lock.json'), '{}');
    fs.mkdirSync(sharedSub);
    fs.writeFileSync(path.join(sharedSub, 'keep.txt'), 'keep');

    const wt = await addWorktree(repo, 'linked', PATIENT);
    assert.equal(wt.ok, true, JSON.stringify(wt));
    // The exact trap: node_modules (root and a sub-folder) junctioned to the main checkout's.
    links.push(path.join(wt.root, 'node_modules'), path.join(wt.root, 'pkg', 'node_modules'));
    fs.symlinkSync(shared, links[0], 'junction');
    fs.symlinkSync(sharedSub, links[1], 'junction');
    assert.equal(fs.lstatSync(links[0]).isSymbolicLink(), true, 'a junction reads as a link');

    const res = await removeWorktree(repo, wt.root, PATIENT);
    assert.deepEqual(res, { ok: true });
    assert.equal(fs.existsSync(wt.root), false, 'the worktree is gone');
    assert.deepEqual(fs.readdirSync(shared).sort(), ['.package-lock.json', 'left-pad']);
    assert.equal(fs.readFileSync(path.join(shared, 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1;');
    assert.deepEqual(fs.readdirSync(sharedSub), ['keep.txt']);
  } finally {
    // Never delete through a link: unlink any that is left, then the tree.
    for (const link of links) {
      try {
        fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
    await removeTree(parent);
  }
});
