// ============================================================================
// God Mode post-merge steps (orchestraFinalize.js POST_MERGE_STEPS):
//   - updateLocalBase (worktrees.js): a clean main checkout on the base
//     branch is fast-forwarded and gets `npm ci` when the lockfile changed;
//     a dirty one / another branch is left untouched and reported.
//   - the finalizer runs the steps only after a merge landed, keeps each
//     result in integration.postMerge and puts it in the report.
// git and npm are fake execs; nothing touches a real repo or the network.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { updateLocalBase, NPM_CI_COMMAND } = require('../src/worktrees.js');
const { createFinalizer, POST_MERGE_STEPS } = require('../src/orchestraFinalize.js');
const { buildReport } = require('../src/orchestraReport.js');
const { createPostMergeServices, isInside } = require('../src/orchestraPostMerge.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/**
 * Fake git: `answer(args)` -> {stdout, err, stderr} for one call (args
 * without the leading `-C <cwd>`). Every argv is logged.
 */
function fakeGit(answer) {
  const calls = [];
  const execImpl = (bin, args, opts, cb) => {
    calls.push({ bin, args: args.slice(2), cwd: args[1] });
    const a = answer(args.slice(2)) || {};
    setImmediate(() => cb(a.err ? Object.assign(new Error('git failed'), { code: 1 }) : null, a.stdout || '', a.stderr || ''));
  };
  return { execImpl, calls };
}

/** Fake shell for npm: logs the command string and cwd. */
function fakeShell(ok = true, output = '') {
  const calls = [];
  const shellImpl = (command, opts, cb) => {
    calls.push({ command, cwd: opts.cwd, timeout: opts.timeout });
    setImmediate(() => cb(ok ? null : new Error('npm failed'), ok ? output : '', ok ? '' : output));
  };
  return { shellImpl, calls };
}

/** A checkout on `branch`, `porcelain` as its status, HEAD moving OLD -> NEW on the ff. */
function repoGit({ branch = 'main', porcelain = '', changed = 'package-lock.json\n', ffFails = false } = {}) {
  let merged = false;
  return fakeGit((args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: '/repo\n' };
    if (args[0] === 'symbolic-ref') return { stdout: `${branch}\n` };
    if (args[0] === 'status') return { stdout: porcelain };
    if (args[0] === 'rev-parse') return { stdout: `${merged ? NEW : OLD}\n` };
    if (args[0] === 'merge') {
      if (ffFails) return { err: true, stderr: 'fatal: Not possible to fast-forward, aborting.\n' };
      merged = true;
      return { stdout: 'Fast-forward\n' };
    }
    if (args[0] === 'diff') return { stdout: changed };
    return {};
  });
}

const lockfileExists = { existsSync: () => true };
const FORBIDDEN = ['reset', 'stash', 'push', 'checkout', 'clean'];
const assertNoForce = (calls) => {
  for (const c of calls) {
    assert.equal(c.bin, 'git');
    assert.ok(!FORBIDDEN.includes(c.args[0]), `unexpected git ${c.args[0]}`);
    assert.ok(!c.args.includes('--force') && !c.args.includes('-f'), 'no force flags');
  }
};

// ---------------------------------------------------------------------------
// updateLocalBase
// ---------------------------------------------------------------------------

test('clean tree on the base branch: ff-only merge of origin/<base>, then npm ci when the lockfile changed', async () => {
  const git = repoGit({ changed: 'package-lock.json\n' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo/sub', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });

  assert.equal(res.updated, true);
  assert.equal(res.reason, null);
  assert.equal(res.from, OLD);
  assert.equal(res.to, NEW);
  assert.deepEqual(res.install, { ran: true, ok: true, skipped: null, detail: null });
  const merge = git.calls.find((c) => c.args[0] === 'merge');
  assert.deepEqual(merge.args, ['merge', '--ff-only', 'origin/main']);
  assert.equal(merge.cwd, '/repo', 'runs in the checkout top level');
  const diff = git.calls.find((c) => c.args[0] === 'diff');
  assert.deepEqual(diff.args, ['diff', '--name-only', OLD, NEW, '--', 'package.json', 'package-lock.json']);
  assert.equal(npm.calls.length, 1);
  assert.equal(npm.calls[0].command, NPM_CI_COMMAND);
  assert.equal(npm.calls[0].command, 'npm ci --no-audit --no-fund');
  assert.equal(npm.calls[0].cwd, '/repo');
  assert.ok(npm.calls[0].timeout > 0, 'npm ci has a bounded timeout');
  assertNoForce(git.calls);
});

test('package.json alone changing also triggers npm ci', async () => {
  const git = repoGit({ changed: 'package.json\n' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.install.ran, true);
  assert.equal(npm.calls.length, 1);
});

test('no dependency change: fast-forward only, no npm ci', async () => {
  const git = repoGit({ changed: '' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.updated, true);
  assert.equal(res.install, null);
  assert.equal(npm.calls.length, 0);
});

test('a failing npm ci is reported, the fast-forward still counts', async () => {
  const git = repoGit();
  const npm = fakeShell(false, 'npm ERR! code EUSAGE\nnpm ERR! lock out of sync');
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.updated, true);
  assert.equal(res.install.ok, false);
  assert.equal(res.install.detail, 'npm ERR! lock out of sync');
});

test('dirty tree: nothing is merged, installed, reset or stashed', async () => {
  const git = repoGit({ porcelain: ' M src/main.js\n?? notes.txt\n' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.updated, false);
  assert.equal(res.reason, 'uncommitted changes');
  assert.equal(res.install, null);
  assert.ok(!git.calls.some((c) => c.args[0] === 'merge'), 'no merge');
  assert.equal(npm.calls.length, 0);
  assertNoForce(git.calls);
});

test('another branch checked out: untouched, the branch named as the reason', async () => {
  const git = repoGit({ branch: 'feature/x' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.updated, false);
  assert.equal(res.reason, 'on branch feature/x');
  assert.ok(!git.calls.some((c) => c.args[0] === 'merge' || c.args[0] === 'status'));
  assert.equal(npm.calls.length, 0);
});

test('a fast-forward git refuses (local commits) is reported, never forced', async () => {
  const git = repoGit({ ffFails: true });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: lockfileExists });
  assert.equal(res.updated, false);
  assert.match(res.reason, /^fast-forward failed: fatal: Not possible to fast-forward/);
  assert.equal(npm.calls.length, 0);
  assertNoForce(git.calls);
});

test('skipInstall keeps npm ci out of a checkout LunaCore runs from', async () => {
  const git = repoGit();
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', {
    execImpl: git.execImpl,
    shellImpl: npm.shellImpl,
    fsImpl: lockfileExists,
    skipInstall: () => 'LunaCore runs from this checkout',
  });
  assert.equal(res.updated, true);
  assert.deepEqual(res.install, { ran: false, ok: false, skipped: 'LunaCore runs from this checkout', detail: null });
  assert.equal(npm.calls.length, 0);
});

test('no package-lock.json: npm ci is skipped with a reason', async () => {
  const git = repoGit({ changed: 'package.json\n' });
  const npm = fakeShell(true);
  const res = await updateLocalBase('/repo', 'main', { execImpl: git.execImpl, shellImpl: npm.shellImpl, fsImpl: { existsSync: () => false } });
  assert.equal(res.install.skipped, 'no package-lock.json');
  assert.equal(npm.calls.length, 0);
});

test('a base branch name that could be an option is refused before git runs', async () => {
  const git = repoGit();
  for (const bad of ['--upload-pack=x', '../main', '', null, 'main.lock']) {
    const res = await updateLocalBase('/repo', bad, { execImpl: git.execImpl });
    assert.equal(res.updated, false);
    assert.equal(res.reason, 'bad base branch');
  }
  assert.equal(git.calls.length, 0);
});

test('createPostMergeServices never installs inside the folder LunaCore runs from', async () => {
  let seen = null;
  const services = createPostMergeServices({
    appPath: () => '/repo',
    git: {
      updateLocalBase: async (repoPath, base, opts) => {
        seen = { repoPath, base, skip: opts.skipInstall('/repo'), other: opts.skipInstall('/elsewhere') };
        return { updated: true };
      },
    },
  });
  await services.impls.updateLocalBase({ repoPath: '/repo/app', base: 'main' });
  assert.deepEqual(seen, { repoPath: '/repo/app', base: 'main', skip: 'LunaCore runs from this checkout', other: null });
  assert.equal(isInside('/repo', '/repo/src'), true);
  assert.equal(isInside('/repo', '/repo2'), false);
});

// ---------------------------------------------------------------------------
// The finalizer's post-merge seam
// ---------------------------------------------------------------------------

function makePlan(overrides = {}) {
  return {
    id: 'pabc123',
    projectId: 'proj1',
    repoPath: '/repo',
    baseBranch: 'main',
    integrationMode: 'merge',
    workerModel: 'opus',
    permissionMode: 'bypassPermissions',
    notes: '',
    approvalLog: [],
    options: {},
    integration: { state: 'idle', error: null, detail: null, at: null },
    packages: [
      { id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core-ab12c', dependsOn: [], verify: 'npm test', merged: false },
      { id: 'ui', title: 'UI', state: 'pushed', branch: 'luna/ui-cd34e', dependsOn: [], verify: 'npm test', merged: false },
    ],
    ...overrides,
  };
}

function harness(plan, { integrateMerge, postMerge } = {}) {
  const events = [];
  const reports = [];
  let now = 1000;
  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => Object.assign(plan.packages.find((p) => p.id === id), fields),
    commit: () => {},
    view: () => ({ ...plan, packages: plan.packages.map((p) => ({ ...p })), integration: { ...plan.integration } }),
    onRunEvent: (kind, data) => events.push({ kind, data }),
    now: () => (now += 1),
    integrateMerge,
    writeReport: (id, text) => {
      reports.push(text);
      return `/runs/${id}.md`;
    },
    postMerge,
    sleep: async () => {},
  });
  return { finalizer, events, reports };
}

const landedMerge = async () => ({ ok: true, merged: ['core', 'ui'], skipped: [], headSha: NEW });

test('POST_MERGE_STEPS is an ordered list starting with the local base update', () => {
  assert.ok(Array.isArray(POST_MERGE_STEPS));
  assert.equal(POST_MERGE_STEPS[0].name, 'localBase');
  assert.equal(POST_MERGE_STEPS[0].impl, 'updateLocalBase');
  assert.ok(Object.isFrozen(POST_MERGE_STEPS));
});

test('a landed merge runs the local base step and keeps its result for board and report', async () => {
  const plan = makePlan();
  const seen = [];
  const postMerge = {
    updateLocalBase: async (ctx) => {
      seen.push(ctx);
      return { updated: true, reason: null, from: OLD, to: NEW, install: { ran: true, ok: true, skipped: null, detail: null } };
    },
  };
  const { finalizer, reports, events } = harness(plan, { integrateMerge: landedMerge, postMerge });
  assert.equal(await finalizer.finalize(), true);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].base, 'main');
  assert.equal(seen[0].repoPath, '/repo');
  assert.equal(seen[0].headSha, NEW);
  assert.equal(seen[0].integrationBranch, 'luna/pabc123-integration');
  assert.deepEqual(seen[0].packages.map((p) => [p.id, p.merged, p.skipped]), [['core', true, false], ['ui', true, false]]);
  assert.equal(plan.integration.state, 'done');
  assert.equal(plan.integration.headSha, NEW);
  assert.equal(plan.integration.postMerge.localBase.updated, true);
  assert.ok(Number.isFinite(plan.integration.postMerge.localBase.at));
  assert.ok(events.some((e) => e.kind === 'postMerge' && e.data.step === 'localBase'));
  const report = reports[reports.length - 1];
  assert.match(report, /## After the merge/);
  assert.match(report, /- Local main fast-forwarded: aaaaaaa\.\.bbbbbbb/);
  assert.match(report, /- npm ci: done/);
});

test('a dirty local base is reported as "local main not updated: uncommitted changes"', async () => {
  const plan = makePlan();
  const postMerge = { updateLocalBase: async () => ({ updated: false, reason: 'uncommitted changes', from: null, to: null, install: null }) };
  const { finalizer, reports } = harness(plan, { integrateMerge: landedMerge, postMerge });
  await finalizer.finalize();
  assert.match(reports[reports.length - 1], /- local main not updated: uncommitted changes/);
});

test('no post-merge step runs when nothing landed: pr mode, a failed merge, nothing new', async () => {
  let calls = 0;
  const postMerge = { updateLocalBase: async () => (calls += 1) };

  const pr = makePlan({ integrationMode: 'pr' });
  await harness(pr, { postMerge }).finalizer.finalize();

  const failed = makePlan();
  await harness(failed, { integrateMerge: async () => ({ ok: false, merged: [], skipped: [], stage: 'push', detail: 'rejected' }), postMerge }).finalizer.finalize();
  assert.equal(failed.integration.state, 'failed');

  const nothingNew = makePlan({ packages: makePlan().packages.map((p) => ({ ...p, merged: true })) });
  await harness(nothingNew, { integrateMerge: landedMerge, postMerge }).finalizer.finalize();

  assert.equal(calls, 0);
  assert.equal(failed.integration.postMerge, undefined);
});

test('a step that throws is recorded as an error and the report still gets written', async () => {
  const plan = makePlan();
  const postMerge = {
    updateLocalBase: async () => {
      throw new Error('git exploded');
    },
  };
  const { finalizer, reports } = harness(plan, { integrateMerge: landedMerge, postMerge });
  assert.equal(await finalizer.finalize(), true);
  assert.equal(plan.integration.postMerge.localBase.error, 'git exploded');
  assert.match(reports[reports.length - 1], /- localBase failed: git exploded/);
});

test('buildReport leaves the post-merge section out when no step ran', () => {
  const text = buildReport(
    { id: 'p1', repoPath: '/r', workerModel: 'opus', permissionMode: 'x', packages: [], integration: { state: 'done' } },
    { now: 1, suggestions: [] },
  );
  assert.doesNotMatch(text, /## After the merge/);
});
