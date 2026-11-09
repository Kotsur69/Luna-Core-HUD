// God Mode "Workers" selector (FREE_GODMODE_V2_PLAN.md Slice F6) end to end
// with faked git/tabs: a hybrid plan asks the planner for "free", the guard
// moves risky free packages to Sonnet with a reason on the board, and the
// Approve choice ("Free only" replaces the old tick) is honoured.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const { DEFAULT_PROTECTED } = require('../src/orchestraHybridGuard');

const base = { todoAts: [1], dependsOn: [], verify: 'npm test' };
const PACKAGES = [
  { ...base, id: 'css', title: 'Header colour', prompt: 'make it red', files: ['src/renderer/styles.css'], model: 'free' },
  { ...base, id: 'ipc', title: 'Wire it', prompt: 'wire', files: ['src/preload.js'], model: 'free' },
  { ...base, id: 'big', title: 'Logic', prompt: 'logic', files: ['src/a.js'], model: 'opus' },
];

function setup({ packages = PACKAGES, extraDeps = {} } = {}) {
  const log = { plannerArgs: [], sessions: [], protectedFor: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async (args) => {
      log.plannerArgs.push(args);
      return { ok: true, raw: { packages, notes: '' }, costUsd: 0 };
    },
    addWorktree: async (repo, name, opts) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `${opts.branchPrefix || 'luna/'}${name}` }),
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
    freeProfileId: () => 'free-a',
    hybridProtected: (repoPath) => {
      log.protectedFor.push(repoPath);
      return DEFAULT_PROTECTED;
    },
    ...extraDeps,
  });
  return { orch, log };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test('Claude only: the planner call carries no hybrid key and no guard runs', async () => {
  const { orch, log } = setup({ packages: [{ ...PACKAGES[2] }] });
  const { plan } = await orch.makePlan(ctx);
  assert.ok(!('hybrid' in log.plannerArgs[0]));
  assert.equal(log.protectedFor.length, 0);
  assert.equal(plan.workers, 'claude');
});

test('Claude only: a "free" pick from the planner is not accepted', async () => {
  const { orch } = setup({ packages: [{ ...PACKAGES[0] }] });
  const { plan } = await orch.makePlan(ctx);
  assert.notEqual(plan.packages[0].model, 'free');
});

test('hybrid: the planner is asked for free picks; the guard moves risky ones to Sonnet with a reason', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan({ ...ctx, workers: 'hybrid' });
  assert.equal(log.plannerArgs[0].hybrid, true);
  assert.deepEqual(log.protectedFor, ['/repo']);
  assert.equal(plan.workers, 'hybrid');
  const byId = Object.fromEntries(plan.packages.map((p) => [p.id, p]));
  assert.equal(byId.css.model, 'free');
  assert.equal(byId.css.hybridGuard, null);
  assert.equal(byId.ipc.model, 'sonnet');
  assert.deepEqual(byId.ipc.hybridGuard, { from: 'free', reasons: [{ code: 'protected', kind: 'preload', file: 'src/preload.js' }] });
  assert.equal(byId.big.model, 'opus');
});

test('hybrid: a free planner always makes a free-only run', async () => {
  const { orch, log } = setup({ packages: [{ ...PACKAGES[2] }], extraDeps: { freePlannerEnv: () => ({}) } });
  const res = await orch.makePlan({ ...ctx, workers: 'hybrid', planner: 'free' });
  assert.ok(!('hybrid' in log.plannerArgs[0]));
  if (res.ok) assert.equal(res.plan.workers, 'free');
});

test('Approve "Free only" (workers) starts a free run like the old tick', async () => {
  const { orch, log } = setup({ packages: [{ ...PACKAGES[2] }] });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'free' });
  assert.equal(res.ok, true);
  assert.equal(res.plan.freeMode, true);
  assert.equal(res.plan.workers, 'free');
  assert.equal(log.sessions[0].profileId, 'free-a');
});

test('Approve hybrid: a free package runs on Sonnet for now, the run stays a Claude run', async () => {
  // Worker model "As planned" (Settings): each package's planner pick counts.
  const workerSettings = () => ({ model: 'plan', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] });
  const { orch, log } = setup({ packages: [{ ...PACKAGES[0] }], extraDeps: { workerSettings } });
  const { plan } = await orch.makePlan({ ...ctx, workers: 'hybrid' });
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
  assert.equal(res.ok, true);
  assert.equal(res.plan.freeMode, false);
  assert.equal(res.plan.workers, 'hybrid');
  assert.equal(log.sessions[0].profileId, 'claude-cloud');
  assert.equal(log.sessions[0].task.model, 'sonnet');
});

test('Approve hybrid on a Claude-planned plan is a Claude-only run', async () => {
  const { orch } = setup({ packages: [{ ...PACKAGES[2] }] });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
  assert.equal(res.ok, true);
  assert.equal(res.plan.workers, 'claude');
  assert.equal(res.plan.freeMode, false);
});
