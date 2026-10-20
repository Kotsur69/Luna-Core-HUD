// God Mode "free providers" runs end to end with faked git/tabs: workers on
// the free profile, luna-free/ worktree branches, branches-only integration,
// and a push even after a failed verify (src/orchestraFinish.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const { finishPackage } = require('../src/orchestraFinish');
const { addWorktree } = require('../src/worktrees');
const { normalizeStoredPlan } = require('../src/orchestraSupervisor');

const pkg = { id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' };

function setup({ freeProfileId = 'free-a', branchOverride = null } = {}) {
  const log = { worktreeOpts: [], sessions: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg], notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name, opts) => {
      log.worktreeOpts.push(opts);
      const branch = branchOverride || `${opts.branchPrefix || 'luna/'}${name}`;
      return { ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch };
    },
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
    freeProfileId: () => freeProfileId,
  });
  return { orch, log };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test('Approve with free: workers on the free profile, luna-free/ branches, branches-only', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, integration: 'merge', free: true });
  assert.equal(res.ok, true);
  assert.equal(res.plan.freeMode, true);
  assert.equal(res.plan.integrationMode, 'branches', 'merge is never honoured on a free run');
  assert.equal(log.worktreeOpts[0].branchPrefix, 'luna-free/');
  assert.equal(log.sessions[0].profileId, 'free-a');
  assert.match(log.sessions[0].branch, /^luna-free\//);
});

test('free without a chain profile is refused before anything launches', async () => {
  const { orch, log } = setup({ freeProfileId: null });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  assert.deepEqual(res, { ok: false, error: 'noFreeProfile' });
  assert.equal(log.sessions.length, 0);
});

test('a free package whose worktree is not on a luna-free/ branch never starts', async () => {
  const { orch, log } = setup({ branchOverride: 'main' });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, free: true });
  assert.equal(log.sessions.length, 0);
  const view = res.plan || orch.view();
  assert.equal(view.packages[0].error, 'unsafeBranch');
});

test('a normal run keeps luna/ branches and the session profile', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id, ids: null, prompts: {}, integration: 'branches' });
  assert.equal(log.worktreeOpts[0].branchPrefix, undefined);
  assert.equal(log.sessions[0].profileId, 'claude-cloud');
});

test('a stored free run stays branches-only after a restart', () => {
  const restored = normalizeStoredPlan({
    id: 'p1', repoPath: process.cwd(), profileId: 'free-a', freeMode: true, integrationMode: 'merge',
    packages: [{ ...pkg, state: 'pending' }],
  });
  assert.equal(restored.freeMode, true);
  assert.equal(restored.integrationMode, 'branches');
});

// --- finish + worktree git (faked) ----------------------------------------------------

function fakeGit(responses = {}) {
  const calls = [];
  const execImpl = (cmd, rawArgs, opts, cb) => {
    // runGit prefixes every call with `-C <cwd>`.
    const args = rawArgs[0] === '-C' ? rawArgs.slice(2) : rawArgs;
    calls.push(args.join(' '));
    const hit = Object.entries(responses).find(([k]) => args.join(' ').startsWith(k));
    const r = hit ? hit[1] : { stdout: '' };
    cb(r.error || null, r.stdout || '', r.stderr || '');
  };
  return { execImpl, calls };
}

test('finishPackage pushes a free branch even when verify fails', async () => {
  const { execImpl, calls } = fakeGit({ 'status --porcelain': { stdout: '' }, 'rev-list': { stdout: '2\n' } });
  const res = await finishPackage(
    { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna-free/a-1', baseSha: 'abc1234', verify: 'npm test', pushOnVerifyFail: true },
    { execImpl, verifyImpl: async () => ({ ok: false, output: 'boom' }) },
  );
  assert.equal(res.stage, 'verify');
  assert.equal(res.pushed, true);
  assert.ok(calls.some((c) => c === 'push -u origin refs/heads/luna-free/a-1'));
});

test('finishPackage on a normal run does not push after a failed verify', async () => {
  const { execImpl, calls } = fakeGit({ 'status --porcelain': { stdout: '' }, 'rev-list': { stdout: '2\n' } });
  const res = await finishPackage(
    { id: 'a', root: '/wt/a', cwd: '/wt/a', branch: 'luna/a-1', baseSha: 'abc1234', verify: 'npm test' },
    { execImpl, verifyImpl: async () => ({ ok: false, output: 'boom' }) },
  );
  assert.equal(res.stage, 'verify');
  assert.ok(!calls.some((c) => c.startsWith('push')));
});

test('addWorktree honours only the known branch prefixes', async () => {
  const fsImpl = { existsSync: () => false, readdirSync: () => [] };
  const run = async (branchPrefix) => {
    const { execImpl, calls } = fakeGit({ 'rev-parse --show-toplevel': { stdout: '/repo\n' }, 'rev-parse --verify': { stdout: 'abc\n' } });
    const res = await addWorktree('/repo', 'pkg one', { execImpl, fsImpl, branchPrefix });
    return { res, add: calls.find((c) => c.startsWith('worktree add')) };
  };
  assert.equal((await run('luna-free/')).res.branch, 'luna-free/pkg-one');
  assert.equal((await run(undefined)).res.branch, 'luna/pkg-one');
  assert.equal((await run('main')).res.branch, 'luna/pkg-one', 'an unknown prefix falls back to luna/');
});
