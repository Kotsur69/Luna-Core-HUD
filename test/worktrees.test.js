// Tests for src/worktrees.js - the "New tab in worktree" plumbing
// (DONE_ORCHESTRATOR_PLAN.md slice 1). Pure helpers first, then real temp git
// repos for addWorktree, since the whole point is what git actually does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { removeDir } = require('../test-support/under-load');
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
  ADD_TIMEOUT_MS,
  createVerifySemaphore,
  sharedVerifySemaphore,
  DEFAULT_VERIFY_CONCURRENCY,
  checkMainNodeModules,
  linkNodeModules,
  createWorktreePool,
  DEFAULT_WARM_POOL_SIZE,
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

test('addWorktree: `git worktree add` gets the longer checkout limit, not the 30s guard', async () => {
  // Regression: a 1241-file checkout on a loaded PC was killed at 95% by the
  // generic 30s GIT_TIMEOUT_MS, and every retry redid the whole checkout.
  const calls = [];
  const execImpl = (cmd, args, opts, cb) => {
    calls.push({ args: args.slice(2), timeout: opts.timeout });
    if (args[2] === 'rev-parse' && args[3] === '--show-toplevel') return cb(null, 'C:/repo\n', '');
    if (args[2] === 'rev-parse') return cb(null, 'abc1234\n', '');
    return cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '', 'Updating files: 95% (1179/1241)\n');
  };
  const res = await addWorktree('C:\\repo', 'x', { execImpl, fsImpl: { existsSync: () => false } });
  const add = calls.find((c) => c.args[0] === 'worktree');
  assert.ok(ADD_TIMEOUT_MS > GIT_TIMEOUT_MS);
  assert.equal(add.timeout, ADD_TIMEOUT_MS);
  assert.ok(calls.filter((c) => c.args[0] === 'rev-parse').every((c) => c.timeout === GIT_TIMEOUT_MS), 'quick checks keep the 30s guard');
  assert.equal(res.error, 'gitFailed');
  assert.equal(res.retryable, true, 'a killed checkout is still retried');
  assert.match(res.detail, new RegExp(`timed out after ${ADD_TIMEOUT_MS / 1000}s`));
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

// Real git with no kill timer. addWorktree's own limits (30s GIT_TIMEOUT_MS
// for probes, ADD_TIMEOUT_MS for the checkout) are production guards against
// a hung git; on a loaded machine (several suites running at once) git has
// taken longer than the 30s probe limit, and a killed git surfaces as
// gitFailed - a flake, not a bug.
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
  return { parent, repo, cleanup: () => removeDir(parent) };
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
    await cleanup();
  }
});

test('addWorktree opens the same sub-folder inside the worktree', async () => {
  const { parent, repo, cleanup } = makeRepo();
  try {
    const res = await addWorktree(path.join(repo, 'pkg'), 'sub', PATIENT);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.cwd, path.join(parent, WORKTREE_DIR, 'app', 'sub', 'pkg'));
  } finally {
    await cleanup();
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
    await cleanup();
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
    await cleanup();
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
    await cleanup();
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

// ---- verification concurrency semaphore --------------------------------------

test('createVerifySemaphore serializes work by default (maxConcurrency = 1) in FIFO order', async () => {
  assert.equal(DEFAULT_VERIFY_CONCURRENCY, 1);
  let clock = 1000;
  const sem = createVerifySemaphore({ now: () => clock });
  assert.deepEqual(sem.stats(), { active: 0, queued: 0, maxConcurrency: 1 });

  let running = 0;
  let maxRunning = 0;
  const order = [];
  const queuedEvents = [];
  const gates = [];

  const job = (name) =>
    sem.run(
      async ({ waited, waitedMs }) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start:${name}:${waited ? `waited:${waitedMs}` : 'now'}`);
        await new Promise((resolve) => gates.push(resolve));
        order.push(`end:${name}`);
        running -= 1;
        return name;
      },
      { onQueued: (info) => queuedEvents.push([name, info.ahead]) },
    );

  const p1 = job('a');
  const p2 = job('b');
  const p3 = job('c');
  await new Promise((r) => setImmediate(r));

  assert.equal(running, 1);
  assert.deepEqual(sem.stats(), { active: 1, queued: 2, maxConcurrency: 1 });
  assert.deepEqual(queuedEvents, [
    ['b', 1],
    ['c', 2],
  ]);

  clock = 1500;
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 1);
  assert.deepEqual(sem.stats(), { active: 1, queued: 1, maxConcurrency: 1 });

  clock = 2200;
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  gates.shift()();

  assert.deepEqual(await Promise.all([p1, p2, p3]), ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(sem.stats(), { active: 0, queued: 0, maxConcurrency: 1 });
  assert.deepEqual(order, [
    'start:a:now',
    'end:a',
    'start:b:waited:500',
    'end:b',
    'start:c:waited:1200',
    'end:c',
  ]);
});

test('createVerifySemaphore enforces bounded concurrency > 1, releases on errors, and skips cancelled waiters', async () => {
  const sem = createVerifySemaphore({ maxConcurrency: 2 });
  assert.equal(sem.maxConcurrency, 2);
  let active = 0;
  let peak = 0;
  const resolvers = [];

  const task = (id, shouldFail = false) =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => resolvers.push(r));
      active -= 1;
      if (shouldFail) throw new Error(`boom:${id}`);
      return id;
    });

  let cancelled = false;
  let skippedRan = false;
  const p1 = task('one', true);
  const p2 = task('two');
  const pSkip = sem.run(
    async () => {
      skippedRan = true;
      return 'should-not-run';
    },
    { isCancelled: () => cancelled, cancelledValue: { cancelled: true } },
  );
  const p3 = task('three');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(sem.stats(), { active: 2, queued: 2, maxConcurrency: 2 });
  cancelled = true;
  resolvers.shift()();
  await assert.rejects(p1, /boom:one/);
  assert.deepEqual(await pSkip, { cancelled: true });
  assert.equal(skippedRan, false);

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sem.stats(), { active: 2, queued: 0, maxConcurrency: 2 });
  resolvers.shift()();
  resolvers.shift()();
  assert.deepEqual(await Promise.all([p2, p3]), ['two', 'three']);
  assert.equal(peak, 2);
  assert.deepEqual(sem.stats(), { active: 0, queued: 0, maxConcurrency: 2 });

  // Already-cancelled caller never enters the queue even while the semaphore is busy.
  const holdSlot = await sem.acquire();
  const preCancelled = await sem.run(() => 'never', { isCancelled: () => true, cancelledValue: 'pre-cancelled' });
  assert.equal(preCancelled, 'pre-cancelled');
  assert.deepEqual(sem.stats(), { active: 1, queued: 0, maxConcurrency: 2 });
  holdSlot.release();

  // Double-release on acquire() is a no-op and does not corrupt active count.
  const slot = await sem.acquire();
  assert.equal(sem.stats().active, 1);
  slot.release();
  slot.release();
  assert.equal(sem.stats().active, 0);

  // Singleton check.
  assert.equal(sharedVerifySemaphore(), sharedVerifySemaphore());
  assert.equal(sharedVerifySemaphore().maxConcurrency, DEFAULT_VERIFY_CONCURRENCY);
});

// ---- main checkout node_modules pre-check & validated junctions --------------

test('checkMainNodeModules rejects missing, dot-only, and non-directory node_modules and passes populated ones', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-nm-check-'));
  try {
    assert.equal(checkMainNodeModules('').reason, 'badPath');
    assert.equal(checkMainNodeModules(tmp).reason, 'missing');

    const nm = path.join(tmp, 'node_modules');
    fs.mkdirSync(nm);
    assert.equal(checkMainNodeModules(tmp).reason, 'empty');

    fs.mkdirSync(path.join(nm, '.bin'));
    fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');
    assert.equal(checkMainNodeModules(tmp).reason, 'empty', 'npm bookkeeping alone is empty');

    fs.mkdirSync(path.join(nm, 'pngjs'));
    const ok = checkMainNodeModules(tmp);
    assert.equal(ok.ok, true);
    assert.equal(ok.dir, nm);
    assert.equal(ok.entries, 1);

    // linkNodeModules refuses to overwrite an existing node_modules in the target.
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    assert.equal(linkNodeModules(tmp, wt).error, 'targetExists');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree with linkNodeModules refuses when main node_modules is missing or empty before creating worktree', async () => {
  const { parent, repo, cleanup } = makeRepo();
  try {
    const missing = await addWorktree(repo, 'no-nm', { ...PATIENT, linkNodeModules: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'emptyNodeModules');
    assert.equal(missing.reason, 'missing');
    assert.equal(fs.existsSync(path.join(parent, WORKTREE_DIR, 'app', 'no-nm')), false, 'no worktree created');

    fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
    const empty = await addWorktree(repo, 'empty-nm', { ...PATIENT, linkNodeModules: true });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'emptyNodeModules');
    assert.equal(empty.reason, 'empty');
    assert.equal(fs.existsSync(path.join(parent, WORKTREE_DIR, 'app', 'empty-nm')), false, 'no worktree created');
  } finally {
    await cleanup();
  }
});

test('addWorktree with linkNodeModules validates main node_modules, links junction, and removeWorktree unlinks before git remove', async () => {
  const root = path.resolve('/repo');
  const target = worktreePathFor(root, 'validated');
  const mainNm = path.join(root, 'node_modules');
  const wtNm = path.join(target, 'node_modules');
  const ops = [];
  const symlinks = new Map();
  const fakeFs = {
    existsSync: (p) => p === target && ops.includes('git:worktree-add'),
    statSync: (p) => {
      if (p === mainNm) return { isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    lstatSync: (p) => {
      if (symlinks.has(p)) return { isSymbolicLink: () => true, isDirectory: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdirSync: (p) => {
      if (p === mainNm) return ['.bin', 'pngjs'];
      return [];
    },
    symlinkSync: (src, dst, type) => {
      ops.push(`symlink:${type}`);
      symlinks.set(dst, src);
    },
    unlinkSync: (p) => {
      ops.push('unlink');
      symlinks.delete(p);
    },
  };
  const fakeExec = (_cmd, args, _opts, cb) => {
    const sub = args.slice(2);
    if (sub[0] === 'rev-parse' && sub[1] === '--show-toplevel') return cb(null, `${root}\n`, '');
    if (sub[0] === 'rev-parse') return cb(null, 'abc1234\n', '');
    if (sub[0] === 'worktree' && sub[1] === 'add') {
      ops.push('git:worktree-add');
      return cb(null, '', '');
    }
    if (sub[0] === 'status') return cb(null, '', '');
    if (sub[0] === 'worktree' && sub[1] === 'remove') {
      ops.push('git:worktree-remove');
      assert.equal(symlinks.has(wtNm), false, 'junction is unlinked before git worktree remove runs');
      return cb(null, '', '');
    }
    return cb(null, '', '');
  };

  const wt = await addWorktree(root, 'validated', { execImpl: fakeExec, fsImpl: fakeFs, linkNodeModules: true });
  assert.equal(wt.ok, true, JSON.stringify(wt));
  assert.equal(wt.nodeModulesLinked, true);
  assert.equal(symlinks.get(wtNm), mainNm);

  const removed = await removeWorktree(root, wt.root, { execImpl: fakeExec, fsImpl: fakeFs });
  assert.deepEqual(removed, { ok: true });
  assert.ok(ops.indexOf('unlink') < ops.indexOf('git:worktree-remove'), 'junction unlinked before git worktree remove');
});

junctionTest('addWorktree with linkNodeModules links populated main node_modules and removeWorktree preserves main target', async (t) => {
  const { repo, cleanup } = makeRepo();
  const mainNm = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(mainNm, 'sample-pkg'), { recursive: true });
  fs.writeFileSync(path.join(mainNm, 'sample-pkg', 'index.js'), 'module.exports = 42;');
  let wt = null;
  try {
    wt = await addWorktree(repo, 'linked-ok', { ...PATIENT, linkNodeModules: true });
    if (!wt.ok && wt.error === 'linkFailed' && /EPERM/i.test(String(wt.detail || ''))) {
      t.skip('cannot create a junction here');
      return;
    }
    assert.equal(wt.ok, true, JSON.stringify(wt));
    assert.equal(wt.nodeModulesLinked, true);
    const linkPath = path.join(wt.root, 'node_modules');
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(linkPath, 'sample-pkg', 'index.js'), 'utf8'), 'module.exports = 42;');

    const removed = await removeWorktree(repo, wt.root, PATIENT);
    assert.deepEqual(removed, { ok: true });
    assert.equal(fs.existsSync(wt.root), false);
    assert.equal(
      fs.readFileSync(path.join(mainNm, 'sample-pkg', 'index.js'), 'utf8'),
      'module.exports = 42;',
      'main checkout node_modules keeps every file after worktree removal',
    );
  } finally {
    if (wt && wt.root && fs.existsSync(path.join(wt.root, 'node_modules'))) {
      try {
        fs.unlinkSync(path.join(wt.root, 'node_modules'));
      } catch {
        /* already removed */
      }
    }
    await cleanup();
  }
});

// ---- optional warm worktree pool ---------------------------------------------

test('createWorktreePool warms up to maxSize, validates main node_modules, claims at latest HEAD, and drains cleanly', async () => {
  const { repo, cleanup } = makeRepo();
  const pool = createWorktreePool({ maxSize: 2, execImpl: PATIENT.execImpl });
  assert.equal(DEFAULT_WARM_POOL_SIZE, 2);
  try {
    // Refuses to warm with linkNodeModules when main node_modules is missing.
    const badWarm = await pool.warm(repo, { linkNodeModules: true });
    assert.equal(badWarm.ok, false);
    assert.equal(badWarm.error, 'emptyNodeModules');
    assert.deepEqual(pool.stats(repo), { size: 0, maxSize: 2 });

    // Warm up to maxSize (2); a 3rd warm is a no-op.
    const w1 = await pool.warm(repo);
    const w2 = await pool.warm(repo);
    const w3 = await pool.warm(repo);
    assert.deepEqual([w1.ok, w1.warmed, w1.size], [true, true, 1]);
    assert.deepEqual([w2.ok, w2.warmed, w2.size], [true, true, 2]);
    assert.deepEqual([w3.ok, w3.warmed, w3.size], [true, false, 2]);

    // Advance main HEAD after warming: acquired worktree must reflect the new commit.
    fs.writeFileSync(path.join(repo, 'pkg', 'fresh.js'), 'module.exports = 2;');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'advance main');
    const latestHead = git(repo, 'rev-parse', 'HEAD');

    const claimed = await pool.acquire(repo, 'Feature Alpha');
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(claimed.fromPool, true);
    assert.equal(claimed.branch, 'luna/feature-alpha');
    assert.equal(git(claimed.root, 'rev-parse', 'HEAD'), latestHead, 'warm worktree advances to latest HEAD');
    assert.equal(git(claimed.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'luna/feature-alpha');
    assert.deepEqual(pool.stats(repo), { size: 1, maxSize: 2 });

    // Drain removes the remaining unused standby worktree cleanly.
    const drained = await pool.drain(repo);
    assert.equal(drained.ok, true, JSON.stringify(drained));
    assert.equal(drained.removed, 1);
    assert.deepEqual(pool.stats(repo), { size: 0, maxSize: 2 });

    // Acquiring from an empty pool falls back transparently to addWorktree.
    const fallback = await pool.acquire(repo, 'Fallback Beta');
    assert.equal(fallback.ok, true, JSON.stringify(fallback));
    assert.equal(fallback.fromPool, undefined);
    assert.equal(fallback.branch, 'luna/fallback-beta');

    assert.deepEqual(await removeWorktree(repo, claimed.root, PATIENT), { ok: true });
    assert.deepEqual(await removeWorktree(repo, fallback.root, PATIENT), { ok: true });
  } finally {
    await pool.drain();
    await cleanup();
  }
});

test('createWorktreePool handles concurrent drain during warm and unlinks junction when acquire requests linkNodeModules: false', async () => {
  const removed = [];
  const unlinked = [];
  let finishAdd;
  const fakeAdd = async (repo, name, opts) => {
    await new Promise((r) => {
      finishAdd = r;
    });
    return {
      ok: true,
      root: path.resolve('/wt', name),
      cwd: path.resolve('/wt', name),
      branch: `luna/${name}`,
      envCopied: 0,
      ...(opts.linkNodeModules ? { nodeModulesLinked: true } : {}),
    };
  };
  const fakeRemove = async (_repo, root) => {
    removed.push(root);
    return { ok: true };
  };
  const fakeRunGit = async (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, stdout: `${path.resolve('/repo')}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc1234\n', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const fakeFs = { existsSync: () => true };

  // 1. drain() while warm() is in flight discards the late worktree cleanly.
  const pool = createWorktreePool({
    maxSize: 2,
    addWorktree: fakeAdd,
    removeWorktree: fakeRemove,
    unlinkDependencyLinks: (root) => {
      unlinked.push(root);
      return { ok: true, unlinked: [path.join(root, 'node_modules')] };
    },
    runGit: fakeRunGit,
    copyEnvFiles: () => 0,
    fsImpl: fakeFs,
  });
  const warming = pool.warm('/repo');
  await new Promise((r) => setImmediate(r));
  await pool.drain('/repo');
  finishAdd();
  const warmRes = await warming;
  assert.deepEqual(warmRes, { ok: true, warmed: false, size: 0 });
  assert.equal(removed.length, 1, 'late warm worktree discarded after drain');
  assert.deepEqual(pool.stats('/repo'), { size: 0, maxSize: 2 });

  // 2. Entry warmed with linkNodeModules: true has its junction unlinked when acquire asks for linkNodeModules: false.
  const warm2 = pool.warm('/repo', { linkNodeModules: true });
  await new Promise((r) => setImmediate(r));
  finishAdd();
  const w2 = await warm2;
  assert.equal(w2.ok, true);
  assert.equal(w2.nodeModulesLinked, true);

  const claimed = await pool.acquire('/repo', 'plain-worker', { linkNodeModules: false });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.fromPool, true);
  assert.equal(claimed.nodeModulesLinked, undefined, 'junction stripped when caller requested linkNodeModules: false');
  assert.deepEqual(unlinked, [w2.root]);
});
