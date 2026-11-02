// ============================================================================
// God Mode branch hygiene + live run options: deleteBranch (worktrees.js),
// failed-launch cleanup and the orphan sweep (orchestraCleanup.js, wired in
// orchestra.js), structured failure records, setOptions validation.
// git is a fake execImpl; nothing touches a real repo.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { deleteBranch, listOwnBranches, worktreeBranches } = require('../src/worktrees.js');
const { orphanBranches, sweepOrphanBranches, launchIdOf } = require('../src/orchestraCleanup.js');
const { createOrchestra } = require('../src/orchestra.js');
const sup = require('../src/orchestraSupervisor.js');

/**
 * Fake git: `answers(args)` returns {stdout, err} for one call; every call's
 * argv is logged so the tests can check no shell string ever runs.
 */
function fakeGit(answers) {
  const calls = [];
  const execImpl = (bin, args, opts, cb) => {
    calls.push({ bin, args });
    const a = answers(args.slice(2)) || {};
    setImmediate(() => cb(a.err ? new Error('git failed') : null, a.stdout || '', a.stderr || ''));
  };
  return { execImpl, calls };
}

const gitArgs = (calls) => calls.map((c) => c.args.slice(2));

// ---------------------------------------------------------------------------
// deleteBranch
// ---------------------------------------------------------------------------

test('deleteBranch deletes a luna/ branch with no own commits, argv arrays only', async () => {
  const git = fakeGit((args) => {
    if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
    if (args[0] === 'rev-list') return { stdout: '0\n' };
    return { stdout: '' };
  });
  const res = await deleteBranch('/repo', 'luna/core-abc12', { execImpl: git.execImpl, base: 'abcdef1' });
  assert.deepEqual(res, { ok: true });
  for (const c of git.calls) {
    assert.equal(c.bin, 'git');
    assert.ok(Array.isArray(c.args));
  }
  const args = gitArgs(git.calls);
  assert.deepEqual(args[1], ['rev-list', '--count', 'abcdef1..refs/heads/luna/core-abc12']);
  assert.deepEqual(args[2], ['branch', '-D', '--', 'luna/core-abc12']);
});

test('deleteBranch keeps a branch that has commits beyond its start point', async () => {
  const git = fakeGit((args) => {
    if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
    if (args[0] === 'rev-list') return { stdout: '3\n' };
    return {};
  });
  const res = await deleteBranch('/repo', 'luna/core-abc12', { execImpl: git.execImpl });
  assert.deepEqual(res, { ok: false, error: 'hasCommits', detail: '3' });
  // Without a base: commits no other local branch has.
  assert.deepEqual(gitArgs(git.calls)[1], [
    'rev-list', '--count', 'refs/heads/luna/core-abc12', '--not', '--exclude=luna/core-abc12', '--branches',
  ]);
  assert.ok(!gitArgs(git.calls).some((a) => a[0] === 'branch'));
});

test('deleteBranch refuses non-luna/ names without running git', async () => {
  const git = fakeGit(() => ({ stdout: '0' }));
  for (const name of ['main', 'luna-free/core-abc12', 'feature/luna/x', '-D', 'luna/../main', 'luna/', 42, null]) {
    assert.deepEqual(await deleteBranch('/repo', name, { execImpl: git.execImpl }), { ok: false, error: 'badName' });
  }
  assert.equal(git.calls.length, 0);
});

test('deleteBranch refuses the checked-out branch and a failed rev-list', async () => {
  const head = fakeGit((args) => (args[0] === 'symbolic-ref' ? { stdout: 'luna/core-abc12\n' } : { stdout: '0' }));
  assert.equal((await deleteBranch('/repo', 'luna/core-abc12', { execImpl: head.execImpl })).error, 'checkedOut');
  const broken = fakeGit((args) => (args[0] === 'rev-list' ? { err: true } : { stdout: 'main' }));
  assert.equal((await deleteBranch('/repo', 'luna/core-abc12', { execImpl: broken.execImpl })).error, 'gitFailed');
});

test('listOwnBranches and worktreeBranches parse git output', async () => {
  const git = fakeGit((args) => {
    if (args[0] === 'for-each-ref') return { stdout: 'luna/a-abc12\nluna/b-xyz99\nluna/Bad Name\n' };
    return {
      stdout: 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt/a\nHEAD 2\nbranch refs/heads/luna/a-abc12\n',
    };
  });
  assert.deepEqual(await listOwnBranches('/repo', { execImpl: git.execImpl }), ['luna/a-abc12', 'luna/b-xyz99']);
  assert.deepEqual(await worktreeBranches('/repo', { execImpl: git.execImpl }), ['main', 'luna/a-abc12']);
});

// ---------------------------------------------------------------------------
// Orphan sweep
// ---------------------------------------------------------------------------

test('launchIdOf matches only <pkgId>-<5-char stamp> of the given ids', () => {
  assert.equal(launchIdOf('luna/core-abc12', ['core']), 'core');
  assert.equal(launchIdOf('luna/core-ui-abc12', ['core', 'core-ui']), 'core-ui');
  assert.equal(launchIdOf('luna/core-ui-abc12', ['core']), null);
  assert.equal(launchIdOf('luna/core', ['core']), null);
  assert.equal(launchIdOf('luna/other-abc12', ['core']), null);
});

test('orphanBranches: only this plan, no worktree, not recorded', () => {
  const out = orphanBranches({
    branches: ['luna/a-aaaaa', 'luna/a-bbbbb', 'luna/a-ccccc', 'luna/b-ddddd', 'luna/zzz-eeeee', 'luna/my-tab'],
    checkedOut: ['main', 'luna/a-bbbbb'],
    packages: [{ id: 'a', branch: 'luna/a-ccccc' }, { id: 'b', branch: null }],
  });
  assert.deepEqual(out, ['luna/a-aaaaa', 'luna/b-ddddd']);
});

test('sweepOrphanBranches deletes orphans, keeps ones deleteBranch refuses', async () => {
  const deleted = [];
  const res = await sweepOrphanBranches({
    repoPath: '/repo',
    packages: [{ id: 'a', branch: null }],
    git: {
      listOwnBranches: async () => ['luna/a-aaaaa', 'luna/a-bbbbb', 'luna/other-ccccc'],
      worktreeBranches: async () => ['main'],
      deleteBranch: async (_repo, b) => {
        if (b === 'luna/a-bbbbb') return { ok: false, error: 'hasCommits' };
        deleted.push(b);
        return { ok: true };
      },
    },
  });
  assert.deepEqual(res, { ok: true, deleted: ['luna/a-aaaaa'], kept: [{ branch: 'luna/a-bbbbb', error: 'hasCommits' }] });
  assert.deepEqual(deleted, ['luna/a-aaaaa']);
});

test('sweepOrphanBranches deletes nothing when the worktree list is unavailable', async () => {
  let called = false;
  const res = await sweepOrphanBranches({
    repoPath: '/repo',
    packages: [{ id: 'a' }],
    git: {
      listOwnBranches: async () => ['luna/a-aaaaa'],
      worktreeBranches: async () => null,
      deleteBranch: async () => {
        called = true;
        return { ok: true };
      },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// orchestra: failed launches leave no worktree or branch
// ---------------------------------------------------------------------------

const pkg = (id, extra = {}) => ({
  id, title: `T ${id}`, todoAts: [1], prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'sonnet', ...extra,
});

function setup(over = {}) {
  const log = { removed: [], deletedBranches: [], deleteArgs: [], saves: [], events: [], logs: [] };
  let clock = 1700000000000;
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a')], notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'abcdef1234',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    removeWorktree: async (_repo, root) => {
      log.removed.push(root);
      return { ok: true };
    },
    deleteBranch: async (_repo, branch, opts) => {
      log.deletedBranches.push(branch);
      log.deleteArgs.push(opts);
      return { ok: true };
    },
    listOwnBranches: async () => over.branches || [],
    worktreeBranches: async () => over.checkedOut || ['main'],
    saveState: (data) => log.saves.push(data),
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    log: (line) => log.logs.push(line),
    setTimer: () => null,
    clearTimer: () => {},
    ...over.deps,
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };
  return { orch, log, ctx, tick: (ms) => { clock += ms; } };
}

test('a launch that fails at the tab removes the worktree and deletes its branch', async () => {
  const { orch, log, ctx } = setup({ deps: { createSession: () => null } });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  const a = orch.view().packages[0];
  assert.equal(a.state, 'failed');
  assert.equal(a.error, 'noTab');
  assert.equal(log.removed.length, 1);
  assert.equal(log.deletedBranches.length, 1);
  assert.match(log.deletedBranches[0], /^luna\/a-[0-9a-z]{5}$/);
  // The recorded start point guards the delete.
  assert.deepEqual(log.deleteArgs[0], { base: 'abcdef1234' });
  assert.equal(a.branch, null);
  assert.deepEqual(a.failure, { code: 'noTab', stage: 'tab', branch: null, files: [], detail: null, at: 1700000000000 });
});

test('a launch that throws is cleaned up too, and a repeat failure gets a new attempt time', async () => {
  let calls = 0;
  const { orch, log, ctx, tick } = setup({
    deps: {
      createSession: () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
    },
  });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  const first = orch.view().packages[0].failure;
  assert.equal(first.code, 'launchThrew');
  assert.equal(first.stage, 'launch');
  assert.equal(log.deletedBranches.length, 1);
  tick(60000);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  const second = orch.view().packages[0].failure;
  assert.equal(second.at, first.at + 60000);
  assert.equal(log.deletedBranches.length, 2);
});

test('a brief that cannot be written leaves no branch either', async () => {
  const { orch, log, ctx } = setup({ deps: { writeBrief: () => false } });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  assert.equal(orch.view().packages[0].failure.code, 'briefFailed');
  assert.equal(log.removed.length, 1);
  assert.equal(log.deletedBranches.length, 1);
});

test('a successful launch deletes nothing and carries no failure', async () => {
  const { orch, log, ctx } = setup();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  const a = orch.view().packages[0];
  assert.equal(a.state, 'launched');
  assert.equal(a.failure, null);
  assert.equal(log.removed.length + log.deletedBranches.length, 0);
});

test('the branch is kept when the worktree could not be removed', async () => {
  const { orch, log, ctx } = setup({
    deps: { createSession: () => null, removeWorktree: async () => ({ ok: false, error: 'dirty' }) },
  });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  assert.equal(log.deletedBranches.length, 0);
  // Still pointing at its worktree, so the work there stays reachable.
  assert.match(orch.view().packages[0].branch, /^luna\/a-/);
});

test("restore() sweeps only this plan's orphaned branches and logs them", async () => {
  const stored = {
    id: 'pold',
    repoPath: path.resolve('/repo'),
    packages: [
      { ...pkg('a'), state: 'failed', branch: null },
      {
        ...pkg('b'),
        state: 'pushed',
        branch: 'luna/b-bbbbb',
        root: path.resolve('/.luna-worktrees/repo/b-bbbbb'),
      },
    ],
  };
  const { orch, log } = setup({
    branches: ['luna/a-aaaaa', 'luna/b-bbbbb', 'luna/b-ccccc', 'luna/other-ddddd', 'luna/a-eeeee'],
    checkedOut: ['main', 'luna/a-eeeee'],
    deps: { loadState: () => stored },
  });
  assert.equal(orch.restore(), true);
  const res = await orch.sweepBranches();
  assert.deepEqual(res.deleted, ['luna/a-aaaaa', 'luna/b-ccccc']);
  // restore's own background sweep ran too; neither touched anything else.
  assert.ok(log.deletedBranches.every((b) => b === 'luna/a-aaaaa' || b === 'luna/b-ccccc'));
  assert.ok(log.logs.some((l) => l.includes('luna/a-aaaaa')));
});

test('a stored failure record is validated', () => {
  assert.equal(sup.normalizeFailure(null), null);
  assert.equal(sup.normalizeFailure({ code: '' }), null);
  const f = sup.normalizeFailure({
    code: 'depMergeFailed',
    stage: 'depMerge',
    branch: 'main; rm -rf',
    files: ['src/a.js', '../etc/passwd', '/abs', 'C:/x', 'src/b.js'],
    detail: 'x'.repeat(500),
    at: 'yesterday',
  });
  assert.deepEqual(f.files, ['src/a.js', 'src/b.js']);
  assert.equal(f.branch, null);
  assert.equal(f.detail.length, 300);
  assert.equal(f.at, null);
  assert.equal(sup.normalizeFailure({ code: 'conflict', branch: 'luna/core-abc12' }).branch, 'luna/core-abc12');
});

// ---------------------------------------------------------------------------
// Live run options
// ---------------------------------------------------------------------------

test('a new plan starts with every run option off', async () => {
  const { orch, ctx } = setup();
  const { plan } = await orch.makePlan(ctx);
  assert.equal(plan.options.sleepOnLimit, false);
  assert.equal(plan.options.shutdownWhenDone, false);
});

test('a legacy stored plan loads with every run option off', () => {
  const stored = sup.normalizeStoredPlan({ id: 'p1', repoPath: path.resolve('/repo'), packages: [pkg('a')] });
  assert.deepEqual(stored.options, { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false });
  const tampered = sup.normalizeStoredPlan({
    id: 'p1', repoPath: path.resolve('/repo'), packages: [pkg('a')], options: { sleepOnLimit: 'yes', shutdownWhenDone: 1 },
  });
  assert.equal(tampered.options.sleepOnLimit, false);
  assert.equal(tampered.options.shutdownWhenDone, false);
});

test('setOptions keeps only known boolean keys', async () => {
  const { orch, ctx } = setup();
  assert.deepEqual(orch.setOptions({ sleepOnLimit: true }), { ok: false, error: 'noPlan' });
  await orch.makePlan(ctx);
  assert.deepEqual(orch.setOptions({ evil: true, sleepOnLimit: 'true' }), { ok: false, error: 'badOptions' });
  assert.deepEqual(orch.setOptions(null), { ok: false, error: 'badOptions' });
  assert.deepEqual(orch.setOptions([true]), { ok: false, error: 'badOptions' });
  const res = orch.setOptions({ sleepOnLimit: true, unattendedApprovalMin: 0, evil: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.options.sleepOnLimit, true);
  assert.equal(res.options.shutdownWhenDone, false);
  // Not a run switch: unchanged.
  assert.equal(res.options.unattendedApprovalMin, 30);
  assert.equal('evil' in res.options, false);
});

test('a mid-run options change is persisted and emitted', async () => {
  const { orch, log, ctx } = setup();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: ['a'] });
  assert.equal(orch.isRunning(), true);
  log.saves.length = 0;
  log.events.length = 0;
  assert.equal(orch.setOptions({ shutdownWhenDone: true }).ok, true);
  assert.equal(log.saves.at(-1).options.shutdownWhenDone, true);
  const ev = log.events.find(([kind]) => kind === 'options');
  assert.ok(ev);
  assert.equal(ev[1].shutdownWhenDone, true);
  assert.equal(orch.view().options.shutdownWhenDone, true);
  // And it survives a reload.
  assert.equal(sup.normalizeStoredPlan(log.saves.at(-1)).options.shutdownWhenDone, true);
});

test('isOptionsPatch: the main-side IPC check is strict', () => {
  assert.equal(sup.isOptionsPatch({ sleepOnLimit: true }), true);
  assert.equal(sup.isOptionsPatch({ sleepOnLimit: false, shutdownWhenDone: true }), true);
  assert.equal(sup.isOptionsPatch({}), false);
  assert.equal(sup.isOptionsPatch(null), false);
  assert.equal(sup.isOptionsPatch([]), false);
  assert.equal(sup.isOptionsPatch({ sleepOnLimit: 1 }), false);
  assert.equal(sup.isOptionsPatch({ sleepOnLimit: true, extra: true }), false);
  assert.equal(sup.isOptionsPatch(Object.create({ sleepOnLimit: true })), false);
  assert.equal(sup.isOptionsPatch(new Date()), false);
});

// ---------------------------------------------------------------------------
// Post-merge cleanup (cleanupMergedRun) on a real temp repo + bare origin
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const wt = require('../src/worktrees.js');
const {
  cleanupMergedRun,
  branchPlan,
  normalizeSettledRun,
  withSettledRun,
  sweepSettledRuns,
  SETTLED_SWEEP_AGE_MS,
} = require('../src/orchestraCleanup.js');
const { createPostMergeServices } = require('../src/orchestraPostMerge.js');
const { POST_MERGE_STEPS } = require('../src/orchestraFinalize.js');

const realGit = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const realGitOps = {
  listWorktrees: (repo) => wt.listWorktrees(repo),
  removeWorktree: (repo, root) => wt.removeWorktree(repo, root),
  pruneWorktrees: (repo) => wt.pruneWorktrees(repo),
  deleteMergedBranch: (repo, branch, base) => wt.deleteMergedBranch(repo, branch, base),
};

/** A clone of a bare origin with one commit on main pushed. */
function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-pm-')));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { windowsHide: true });
  execFileSync('git', ['clone', '-q', origin, repo], { windowsHide: true, stdio: 'ignore' });
  realGit(repo, 'config', 'user.email', 'luna@test');
  realGit(repo, 'config', 'user.name', 'Luna');
  realGit(repo, 'config', 'commit.gpgsign', 'false');
  realGit(repo, 'checkout', '-q', '-b', 'main');
  // No trailing slash: matches a junction / symlink as well as a folder.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  realGit(repo, 'add', '.');
  realGit(repo, 'commit', '-q', '-m', 'init');
  realGit(repo, 'push', '-q', '-u', 'origin', 'main');
  return { dir, repo };
}

/** A `luna/` branch off main with one commit of its own, pushed to origin. */
function packageBranch(repo, branch, file) {
  realGit(repo, 'checkout', '-q', '-b', branch, 'main');
  fs.writeFileSync(path.join(repo, file), `${branch}\n`);
  realGit(repo, 'add', file);
  realGit(repo, 'commit', '-q', '-m', `feat: ${file}`);
  realGit(repo, 'push', '-q', 'origin', branch);
  realGit(repo, 'checkout', '-q', 'main');
}

const localBranches = (repo) =>
  realGit(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split(/\r?\n/)
    .filter(Boolean);
const remoteBranches = (repo) =>
  realGit(repo, 'ls-remote', '--heads', 'origin')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('refs/heads/')[1]);

test('cleanupMergedRun: integration worktree removed with its junctions unlinked, merged branches deleted, the rest kept', async () => {
  const { dir, repo } = tempRepo();
  try {
    packageBranch(repo, 'luna/core-ab12c', 'core.txt');
    packageBranch(repo, 'luna/ui-cd34e', 'ui.txt');
    packageBranch(repo, 'luna/skip-ef56g', 'skip.txt');
    packageBranch(repo, 'luna/wip-gh78i', 'wip.txt');
    // The integration merged core + ui and pushed main.
    realGit(repo, 'merge', '-q', '--no-ff', '-m', 'merge core', 'luna/core-ab12c');
    realGit(repo, 'merge', '-q', '--no-ff', '-m', 'merge ui', 'luna/ui-cd34e');
    realGit(repo, 'push', '-q', 'origin', 'main');
    // The integration worktree is still there (a locked file kept it), with
    // node_modules junctions to a "real" install outside it.
    const shared = path.join(dir, 'shared_modules');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'the real install\n');
    const integ = path.join(dir, 'integration');
    realGit(repo, 'worktree', 'add', '-q', '-b', 'luna/pabc123-integration', integ, 'origin/main');
    fs.symlinkSync(shared, path.join(integ, 'node_modules'), 'junction');
    fs.mkdirSync(path.join(integ, 'mobile'));
    fs.writeFileSync(path.join(integ, 'mobile', 'app.txt'), 'x\n');
    realGit(integ, 'add', 'mobile/app.txt');
    realGit(integ, 'commit', '-q', '-m', 'chore: mobile');
    realGit(integ, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    fs.symlinkSync(shared, path.join(integ, 'mobile', 'node_modules'), 'junction');
    realGit(repo, 'fetch', '-q', 'origin');

    const res = await cleanupMergedRun(
      {
        repoPath: repo,
        base: 'main',
        integrationBranch: 'luna/pabc123-integration',
        packages: [
          { id: 'core', branch: 'luna/core-ab12c', merged: true, skipped: false },
          { id: 'ui', branch: 'luna/ui-cd34e', merged: true, skipped: false },
          { id: 'skip', branch: 'luna/skip-ef56g', merged: false, skipped: true },
          { id: 'wip', branch: 'luna/wip-gh78i', merged: false, skipped: false },
        ],
      },
      realGitOps,
    );

    assert.equal(res.ok, true, res.error || '');
    assert.equal(res.worktree, 'removed');
    assert.deepEqual([...res.deleted].sort(), ['luna/core-ab12c', 'luna/pabc123-integration', 'luna/ui-cd34e']);
    assert.deepEqual(res.kept, [
      { branch: 'luna/skip-ef56g', reason: 'skipped' },
      { branch: 'luna/wip-gh78i', reason: 'notMerged' },
    ]);
    assert.equal(fs.existsSync(integ), false, 'integration worktree folder gone');
    assert.ok(!realGit(repo, 'worktree', 'list', '--porcelain').includes('pabc123-integration'), 'registration pruned');
    // The junction target - the "real" node_modules - is untouched.
    assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'the real install\n');
    assert.deepEqual(localBranches(repo).sort(), ['luna/skip-ef56g', 'luna/wip-gh78i', 'main']);
    // Remote branches are never touched.
    assert.ok(remoteBranches(repo).includes('luna/core-ab12c'));
    assert.ok(remoteBranches(repo).includes('luna/ui-cd34e'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupMergedRun never force-deletes: a "merged" branch with later commits, or one checked out, is kept', async () => {
  const { dir, repo } = tempRepo();
  try {
    packageBranch(repo, 'luna/core-ab12c', 'core.txt');
    packageBranch(repo, 'luna/doc-ij90k', 'doc.txt');
    realGit(repo, 'merge', '-q', '--no-ff', '-m', 'merge core', 'luna/core-ab12c');
    realGit(repo, 'merge', '-q', '--no-ff', '-m', 'merge doc', 'luna/doc-ij90k');
    realGit(repo, 'push', '-q', 'origin', 'main');
    // core got another commit after the merge; doc still sits in its worktree.
    realGit(repo, 'checkout', '-q', 'luna/core-ab12c');
    fs.writeFileSync(path.join(repo, 'late.txt'), 'late\n');
    realGit(repo, 'add', 'late.txt');
    realGit(repo, 'commit', '-q', '-m', 'fix: late');
    realGit(repo, 'checkout', '-q', 'main');
    const docWt = path.join(dir, 'doc');
    realGit(repo, 'worktree', 'add', '-q', docWt, 'luna/doc-ij90k');

    const res = await cleanupMergedRun(
      {
        repoPath: repo,
        base: 'main',
        integrationBranch: 'luna/pabc123-integration',
        packages: [
          { id: 'core', branch: 'luna/core-ab12c', merged: true, skipped: false },
          { id: 'doc', branch: 'luna/doc-ij90k', merged: true, skipped: false },
        ],
      },
      realGitOps,
    );
    assert.equal(res.ok, true);
    assert.equal(res.worktree, 'gone');
    assert.deepEqual(res.deleted, []);
    assert.deepEqual(res.kept, [
      { branch: 'luna/core-ab12c', reason: 'notMerged' },
      { branch: 'luna/doc-ij90k', reason: 'checkedOut' },
    ]);
    assert.deepEqual(localBranches(repo).sort(), ['luna/core-ab12c', 'luna/doc-ij90k', 'main']);
    assert.ok(fs.existsSync(docWt), 'package worktrees are not this step to remove');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree unlinks a node_modules junction before git removes the folder', async () => {
  const { dir, repo } = tempRepo();
  try {
    const shared = path.join(dir, 'real_node_modules');
    fs.mkdirSync(path.join(shared, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'pkg', 'index.js'), 'module.exports = 1;\n');
    const tree = path.join(dir, 'tree');
    realGit(repo, 'worktree', 'add', '-q', '-b', 'luna/tree-aaaaa', tree, 'main');
    fs.symlinkSync(shared, path.join(tree, 'node_modules'), 'junction');
    assert.deepEqual(wt.unlinkNodeModulesLinks(path.join(dir, 'nowhere')), []);
    const res = await wt.removeWorktree(repo, tree);
    assert.deepEqual(res, { ok: true });
    assert.equal(fs.existsSync(tree), false);
    assert.equal(fs.readFileSync(path.join(shared, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unlinkNodeModulesLinks leaves a real node_modules folder for git, unlinks only links', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-nm-')));
  try {
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'x.js'), '1');
    const root = path.join(dir, 'wt');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app'));
    fs.symlinkSync(target, path.join(root, 'app', 'node_modules'), 'junction');
    const unlinked = wt.unlinkNodeModulesLinks(root);
    assert.deepEqual(unlinked, [path.join(root, 'app', 'node_modules')]);
    assert.ok(fs.existsSync(path.join(root, 'node_modules')), 'real folder kept');
    assert.ok(!fs.existsSync(path.join(root, 'app', 'node_modules')));
    assert.ok(fs.existsSync(path.join(target, 'x.js')), 'link target untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure pieces + the start-up sweep (fake git, fake ledger)
// ---------------------------------------------------------------------------

test('branchPlan: merged packages are candidates, skipped / unmerged kept, bad names ignored', () => {
  const plan = branchPlan({
    packages: [
      { branch: 'luna/a-11111', merged: true, skipped: false },
      { branch: 'luna/b-22222', merged: true, skipped: true },
      { branch: 'luna/c-33333', merged: false, skipped: false },
      { branch: 'main', merged: true, skipped: false },
      { branch: null, merged: true, skipped: false },
    ],
  });
  assert.deepEqual(plan.candidates, ['luna/a-11111']);
  assert.deepEqual(plan.kept, [
    { branch: 'luna/b-22222', reason: 'skipped' },
    { branch: 'luna/c-33333', reason: 'notMerged' },
  ]);
});

test('cleanupMergedRun refuses a base that could be an option; a vanished branch is neither deleted nor kept', async () => {
  const bad = await cleanupMergedRun({ repoPath: '/r', base: '--force', packages: [] }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'badBase');
  const git = {
    listWorktrees: async () => [{ root: '/r', branch: 'main' }],
    removeWorktree: async () => assert.fail('no integration worktree to remove'),
    pruneWorktrees: async () => ({ ok: true }),
    deleteMergedBranch: async (repo, branch) => (branch === 'luna/a-11111' ? { ok: true } : { ok: false, error: 'missing' }),
  };
  const res = await cleanupMergedRun(
    {
      repoPath: '/r',
      base: 'main',
      integrationBranch: 'luna/p1-integration',
      packages: [{ id: 'a', branch: 'luna/a-11111', merged: true, skipped: false }],
    },
    git,
  );
  assert.deepEqual(res, { ok: true, worktree: 'gone', deleted: ['luna/a-11111'], kept: [], error: null });
});

test('normalizeSettledRun keeps only what is safe to hand to git', () => {
  const ok = normalizeSettledRun({
    planId: 'pabc',
    repoPath: path.resolve('/repo'),
    base: 'main',
    integrationBranch: 'luna/pabc-integration',
    settledAt: 5,
    packages: [
      { id: 'a', branch: 'luna/a-11111', merged: true },
      { id: 'b', branch: '--delete', merged: true },
      { id: '../x/y', branch: 'luna/x-22222', merged: true },
    ],
  });
  assert.deepEqual(ok.packages, [
    { id: 'a', branch: 'luna/a-11111', merged: true, skipped: false },
    { id: 'b', branch: null, merged: true, skipped: false },
  ]);
  assert.equal(normalizeSettledRun({ ...ok, repoPath: 'relative/path' }), null);
  assert.equal(normalizeSettledRun({ ...ok, base: '-x' }), null);
  assert.equal(normalizeSettledRun({ ...ok, planId: 'P/../1' }), null);
  assert.equal(normalizeSettledRun({ ...ok, settledAt: 'yesterday' }), null);
  assert.equal(normalizeSettledRun({ ...ok, integrationBranch: 'main' }).integrationBranch, null);
});

const ledgerRun = (planId, settledAt, repoPath = path.resolve('/repo')) => ({
  planId,
  repoPath,
  base: 'main',
  integrationBranch: `luna/${planId}-integration`,
  packages: [{ id: 'a', branch: `luna/a-${planId}`, merged: true, skipped: false }],
  settledAt,
});

test('sweepSettledRuns: runs older than a day are cleaned up once, younger ones wait, unknown repos are dropped untouched', async () => {
  const now = 10 * SETTLED_SWEEP_AGE_MS;
  const cleaned = [];
  const res = await sweepSettledRuns({
    runs: [ledgerRun('pold', now - SETTLED_SWEEP_AGE_MS - 1), ledgerRun('pnew', now - 1000), ledgerRun('pgone', 0, path.resolve('/gone'))],
    now,
    isKnownRepo: (p) => p === path.resolve('/repo'),
    cleanup: async (run) => {
      cleaned.push(run.planId);
      return { ok: true, deleted: [] };
    },
  });
  assert.deepEqual(cleaned, ['pold']);
  assert.deepEqual(res.swept.map((s) => s.planId), ['pold']);
  assert.deepEqual(res.remaining.map((r) => r.planId), ['pnew']);
});

test('withSettledRun replaces a run already in the ledger and caps its length', () => {
  const list = withSettledRun([ledgerRun('p1', 1), ledgerRun('p2', 2), { junk: true }], ledgerRun('p1', 3));
  assert.deepEqual(list.map((r) => [r.planId, r.settledAt]), [['p2', 2], ['p1', 3]]);
  let big = [];
  for (let i = 0; i < 60; i += 1) big = withSettledRun(big, ledgerRun(`p${i}`, i));
  assert.equal(big.length, 50);
  assert.equal(big[0].planId, 'p10');
});

function memoryStore(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    loadSettledRuns: () => JSON.parse(JSON.stringify(data)),
    saveSettledRuns: (list) => {
      data = JSON.parse(JSON.stringify(list));
      return true;
    },
    peek: () => data,
  };
}

const fakeGitOps = (log) => ({
  listWorktrees: async () => [],
  removeWorktree: async () => ({ ok: true }),
  pruneWorktrees: async () => ({ ok: true }),
  deleteMergedBranch: async (repo, branch) => {
    log.push(branch);
    return { ok: true };
  },
});

test('the cleanup step records the run in the ledger; sweepAtStart sweeps old runs once and keeps the rest', async () => {
  const now = 10 * SETTLED_SWEEP_AGE_MS;
  const deleted = [];
  const store = memoryStore([ledgerRun('pold1', 1)]);
  const services = createPostMergeServices({ git: fakeGitOps(deleted), store, now: () => now, isKnownRepo: () => true });
  // A run that just landed goes through the post-merge step.
  const res = await services.impls.cleanupMergedRun({
    planId: 'pfresh',
    repoPath: path.resolve('/repo'),
    base: 'main',
    integrationBranch: 'luna/pfresh-integration',
    packages: [{ id: 'core', branch: 'luna/core-ab12c', merged: true, skipped: false }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(store.peek().map((r) => r.planId), ['pold1', 'pfresh']);

  // The restored board's run (landed two days ago, not in the ledger yet) joins the sweep.
  const landed = ledgerRun('pboard', now - 2 * SETTLED_SWEEP_AGE_MS);
  deleted.length = 0;
  const sweep = await services.sweepAtStart(landed);
  assert.deepEqual(sweep.swept.map((s) => s.planId).sort(), ['pboard', 'pold1']);
  assert.deepEqual(store.peek().map((r) => r.planId), ['pfresh'], 'only the young run is left');
  assert.ok(deleted.includes('luna/pold1-integration'));
  // One-time: a second call does nothing.
  assert.deepEqual(await services.sweepAtStart(landed), { swept: [], remaining: [] });
});

test('POST_MERGE_STEPS runs cleanup right after the local base update', () => {
  const names = POST_MERGE_STEPS.map((s) => s.name);
  assert.deepEqual(names.slice(0, 2), ['localBase', 'cleanup']);
  assert.equal(POST_MERGE_STEPS[1].impl, 'cleanupMergedRun');
});
