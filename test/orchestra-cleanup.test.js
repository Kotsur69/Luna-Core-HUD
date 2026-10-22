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
