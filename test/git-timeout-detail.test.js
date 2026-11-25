// ============================================================================
// Git timeouts in the Luna's Work / plan-approve / `luna memory notes` paths:
// every runner takes an injectable timeout (tests under load pass a long one),
// the production defaults are unchanged, and a git call killed by the timer
// comes back with a detail that says 'timed out' instead of an empty string.
// The exec is a fake that answers like child_process.execFile; no real git.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { gitFailure } = require('../src/worktrees');
const checkpoint = require('../src/lunasworkCheckpoint');
const { commitDesignPack } = require('../src/lunasworkPackCommit');
const commit = require('../src/lunasworkCommit');
const graph = require('../src/lunasworkGraph');
const { createPlanApprover } = require('../src/orchestraPlanApprove');
const luna = require('../scripts/luna.js');

/** What execFile hands the callback when its timer killed the process. */
function killedError(args) {
  const err = new Error(`Command failed: git ${args.join(' ')}`);
  err.killed = true;
  err.signal = 'SIGTERM';
  err.code = null;
  return err;
}

/** A git process that exited on its own with `code` and `stderr`. */
function exitError(args, code) {
  const err = new Error(`Command failed: git ${args.join(' ')}`);
  err.code = code;
  return err;
}

/**
 * A fake execFile. `answer(args)` returns {out} for success, 'kill' for a
 * timed-out call, or {code, stderr} for a failed exit. Every call's timeout is
 * recorded.
 */
function fakeExec(answer) {
  const timeouts = [];
  const execImpl = (file, args, opts, cb) => {
    timeouts.push(opts.timeout);
    // runGit prefixes `-C <cwd>`: answer on the git args only.
    const gitArgs = args[0] === '-C' ? args.slice(2) : args;
    const res = answer(gitArgs) || { out: '' };
    setImmediate(() => {
      if (res === 'kill') cb(killedError(gitArgs), '', '');
      else if (res.code) cb(exitError(gitArgs, res.code), res.out || '', res.stderr || '');
      else cb(null, res.out || '', '');
    });
    return { stdin: null };
  };
  return { execImpl, timeouts };
}

const has = (args, word) => args.includes(word);
const tmpDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
};

// ---- the shared helper ----------------------------------------------------------------

test('gitFailure names the timeout first, else git\'s error line, and is never empty', () => {
  assert.equal(gitFailure(killedError(['fetch']), '', 60000), 'git timed out after 60s');
  assert.equal(gitFailure(killedError(['fetch']), 'fatal: half way', 5000), 'git timed out after 5s; fatal: half way');
  assert.equal(gitFailure(exitError(['show'], 128), 'warning: x\nfatal: bad object', 1000), 'fatal: bad object');
  assert.equal(gitFailure(exitError(['symbolic-ref'], 1), '', 1000), 'Command failed: git symbolic-ref');
  assert.equal(gitFailure({}, '', 1000), 'git failed without output');
});

// ---- lunasworkCheckpoint ----------------------------------------------------------------

test('checkpoint: the default git timeout is unchanged (60 s) and a caller can raise it', async () => {
  assert.equal(checkpoint.GIT_TIMEOUT_MS, 60 * 1000);
  const plain = fakeExec(() => ({ out: 'main' }));
  await checkpoint.execGit('x', ['rev-parse', 'HEAD'], { execImpl: plain.execImpl });
  assert.deepEqual(plain.timeouts, [60 * 1000]);
  const longer = fakeExec(() => ({ out: 'main' }));
  await checkpoint.execGit('x', ['rev-parse', 'HEAD'], { execImpl: longer.execImpl, timeoutMs: 600000 });
  assert.deepEqual(longer.timeouts, [600000]);
});

test('checkpoint: a fetch killed by the timeout is fetchFailed with a detail that says so', async () => {
  const fake = fakeExec((args) => (has(args, 'fetch') ? 'kill' : { out: 'main' }));
  const cp = checkpoint.createCheckpoints({ execImpl: fake.execImpl, gitTimeoutMs: 7000 });
  const res = await cp.tagIteration({ repoPath: 'x', runId: 'r1', iteration: 1 });
  assert.equal(res.error, 'fetchFailed', JSON.stringify(res));
  assert.match(res.detail, /timed out after 7s/);
  assert.ok(fake.timeouts.every((ms) => ms === 7000));
});

test('checkpoint: fetchFailed always has a detail, also for output that is not a sha', async () => {
  const fake = fakeExec((args) => (has(args, 'FETCH_HEAD^{commit}') ? { out: 'garbage' } : { out: 'main' }));
  const res = await checkpoint.createCheckpoints({ execImpl: fake.execImpl }).tagIteration({ repoPath: 'x', runId: 'r1', iteration: 1 });
  assert.equal(res.error, 'fetchFailed', JSON.stringify(res));
  assert.match(res.detail, /not a commit sha: garbage/);
  assert.ok(fake.timeouts.every((ms) => ms === checkpoint.GIT_TIMEOUT_MS));
});

test('checkpoint: a failing runner that says nothing still yields a detail', async () => {
  const git = checkpoint.guardedGit(async () => ({ ok: false, out: '', err: '' }));
  assert.match((await git('x', ['fetch', 'origin'])).err, /git fetch failed without output/);
});

// ---- lunasworkPackCommit -------------------------------------------------------------

test('pack commit: default timeout unchanged; a killed status is statusFailed saying timed out', async () => {
  const answer = (args) => (has(args, 'status') ? 'kill' : { out: 'main' });
  const plain = fakeExec(answer);
  const res = await commitDesignPack({ repoPath: 'x', execImpl: plain.execImpl });
  assert.equal(res.error, 'statusFailed', JSON.stringify(res));
  assert.match(res.detail, /timed out after 60s/);
  assert.ok(plain.timeouts.every((ms) => ms === 60 * 1000));

  const longer = fakeExec(answer);
  const slow = await commitDesignPack({ repoPath: 'x', execImpl: longer.execImpl, gitTimeoutMs: 600000 });
  assert.match(slow.detail, /timed out after 600s/);
  assert.ok(longer.timeouts.every((ms) => ms === 600000));
});

test('pack commit: a timed-out HEAD read is notOnBranch with a detail', async () => {
  const fake = fakeExec(() => 'kill');
  const res = await commitDesignPack({ repoPath: 'x', execImpl: fake.execImpl, gitTimeoutMs: 2000 });
  assert.equal(res.error, 'notOnBranch');
  assert.match(res.detail, /timed out after 2s/);
});

// ---- lunasworkCommit ---------------------------------------------------------------------

function commitRepo(t) {
  const repo = tmpDir(t, 'lw-commit-to-');
  fs.writeFileSync(path.join(repo, 'a.md'), 'x\n');
  return repo;
}

const commitAnswer = (args) => {
  if (has(args, 'symbolic-ref')) return { out: 'refs/heads/main' };
  if (has(args, 'read-tree')) return 'kill';
  return { out: 'f'.repeat(40) };
};

test('commit: default timeout unchanged (30 s); a killed read-tree is notStaged saying timed out', async (t) => {
  assert.equal(commit.GIT_TIMEOUT_MS, 30 * 1000);
  const fake = fakeExec(commitAnswer);
  const res = await commit.createCommitter({ execImpl: fake.execImpl, tmpBase: tmpDir(t, 'lw-commit-base-') })
    .commitPaths({ repoPath: commitRepo(t), paths: ['a.md'], message: 'm' });
  assert.equal(res.error, 'notStaged', JSON.stringify(res));
  assert.match(res.detail, /timed out after 30s/);
  assert.ok(fake.timeouts.every((ms) => ms === 30 * 1000));
});

test('commit: gitTimeoutMs reaches every git call', async (t) => {
  const fake = fakeExec(commitAnswer);
  const res = await commit.createCommitter({ execImpl: fake.execImpl, tmpBase: tmpDir(t, 'lw-commit-base-'), gitTimeoutMs: 600000 })
    .commitPaths({ repoPath: commitRepo(t), paths: ['a.md'], message: 'm' });
  assert.match(res.detail, /timed out after 600s/);
  assert.ok(fake.timeouts.length > 1 && fake.timeouts.every((ms) => ms === 600000));
});

test('commit: commit-tree output that is not a sha is notCommitted with a detail', async (t) => {
  const fake = fakeExec((args) => {
    if (has(args, 'symbolic-ref')) return { out: 'refs/heads/main' };
    if (has(args, 'write-tree')) return { out: 'b'.repeat(40) };
    if (has(args, 'commit-tree')) return { out: 'garbage' };
    return { out: 'c'.repeat(40) };
  });
  const res = await commit.createCommitter({ execImpl: fake.execImpl, tmpBase: tmpDir(t, 'lw-commit-base-') })
    .commitPaths({ repoPath: commitRepo(t), paths: ['a.md'], message: 'm' });
  assert.equal(res.error, 'notCommitted', JSON.stringify(res));
  assert.match(res.detail, /not a commit sha: garbage/);
});

// ---- lunasworkGraph ----------------------------------------------------------------------

const envelope = (raw) => ({ stdout: JSON.stringify({ structured_output: raw, total_cost_usd: 0 }) });

/** A refresh whose codemaps commit meets a killed `git read-tree`. */
async function graphWithKilledReadTree(t, extra = {}) {
  const repo = tmpDir(t, 'lw-graph-to-');
  const runClaude = async (o) => {
    if (!o.args.includes('ecc:doc-updater')) return envelope({ indexed: true, detail: 'ok' });
    fs.mkdirSync(path.join(o.cwd, 'docs', 'CODEMAPS'), { recursive: true });
    fs.writeFileSync(path.join(o.cwd, 'docs', 'CODEMAPS', 'overview.md'), '# Overview\n');
    return envelope({ updated: true, summary: 'maps' });
  };
  const fake = fakeExec((args) => (has(args, 'read-tree') ? 'kill' : { out: '' }));
  const { refreshGraph } = graph.createGraphRefresher({
    runClaude, resolveCli: () => null, execImpl: fake.execImpl, tmpBase: tmpDir(t, 'lw-graph-base-'), ...extra,
  });
  const res = await refreshGraph({ repoPath: repo, iteration: 1 });
  return { res, timeouts: fake.timeouts };
}

test('graph: default git timeout unchanged (60 s); a killed read-tree note says timed out', async (t) => {
  assert.equal(graph.GIT_TIMEOUT_MS, 60 * 1000);
  const { res, timeouts } = await graphWithKilledReadTree(t);
  assert.equal(res.codemaps, 'failed', JSON.stringify(res));
  assert.match(res.notes.join('\n'), /codemaps not staged: git timed out after 60s/);
  assert.ok(timeouts.every((ms) => ms === 60 * 1000));
});

test('graph: gitTimeoutMs reaches every git call, the scratch-index steps too', async (t) => {
  const { res, timeouts } = await graphWithKilledReadTree(t, { gitTimeoutMs: 600000 });
  assert.match(res.notes.join('\n'), /codemaps not staged: git timed out after 600s/);
  assert.ok(timeouts.length > 2 && timeouts.every((ms) => ms === 600000));
});

// ---- orchestraPlanApprove ----------------------------------------------------------------

const PLAN_VIEW = {
  id: 'p1',
  baseBranch: 'main',
  planRun: { runSlug: 'demo-plan-ab12cd', ready: true, docs: [{ id: 's', file: 'PLAN.md', branch: 'luna-plan/synthesis-x1' }] },
};

const approverWith = (execImpl, extra = {}) =>
  createPlanApprover({ readTodos: () => [], writeTodos: () => true, execImpl, ...extra });

test('plan approve: default timeout unchanged (runGit 30 s); a killed git is gitFailed saying timed out', async () => {
  const plain = fakeExec(() => 'kill');
  const res = await approverWith(plain.execImpl)({ projectId: 'p', repoPath: 'x', view: PLAN_VIEW });
  assert.equal(res.error, 'gitFailed', JSON.stringify(res));
  assert.match(res.detail, /timed out after 30s/);
  assert.deepEqual(plain.timeouts, [30 * 1000]);

  const longer = fakeExec(() => 'kill');
  const slow = await approverWith(longer.execImpl, { gitTimeoutMs: 600000 })({ projectId: 'p', repoPath: 'x', view: PLAN_VIEW });
  assert.match(slow.detail, /timed out after 600s/);
  assert.deepEqual(longer.timeouts, [600000]);
});

test('plan approve: a failed git show with no stderr still has a detail', async () => {
  const fake = fakeExec((args) => {
    if (has(args, '--abbrev-ref')) return { out: 'main\n' };
    if (has(args, 'MERGE_HEAD')) return { code: 1 };
    if (args.some((a) => a.startsWith('refs/heads/luna-plan/'))) return { out: `${'a'.repeat(40)}\n` };
    if (has(args, 'show')) return { code: 128 };
    return { out: '' };
  });
  const res = await approverWith(fake.execImpl)({ projectId: 'p', repoPath: 'x', view: PLAN_VIEW });
  assert.equal(res.error, 'noPlanDoc', JSON.stringify(res));
  assert.match(res.detail, /git show .*exit 128/);
});

// ---- scripts/luna.js (memory notes) ------------------------------------------------------

test('luna CLI: git timeout is 60 s unless LUNA_GIT_TIMEOUT_MS gives a valid one', () => {
  assert.equal(luna.GIT_TIMEOUT_MS, 60000);
  assert.equal(luna.gitTimeoutMs({}), 60000);
  assert.equal(luna.gitTimeoutMs({ LUNA_GIT_TIMEOUT_MS: '' }), 60000);
  assert.equal(luna.gitTimeoutMs({ LUNA_GIT_TIMEOUT_MS: '600000' }), 600000);
  for (const bad of ['0', '-1', '1.5', 'abc', '1e6', '99999999']) {
    assert.throws(() => luna.gitTimeoutMs({ LUNA_GIT_TIMEOUT_MS: bad }), luna.UsageError, bad);
  }
});

test('luna CLI: a git query killed by the timeout rejects with "timed out"', async () => {
  const plain = fakeExec(() => 'kill');
  await assert.rejects(luna.gitLine(['for-each-ref'], { execImpl: plain.execImpl, timeoutMs: 3000 }), /git timed out after 3s/);
  assert.deepEqual(plain.timeouts, [3000]);
  const ok = fakeExec(() => ({ out: 'v1.0.0\nmore\n' }));
  assert.equal(await luna.gitLine(['for-each-ref'], { execImpl: ok.execImpl }), 'v1.0.0');
  assert.equal(ok.timeouts[0], luna.gitTimeoutMs());
});
