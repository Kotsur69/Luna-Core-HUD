// Free God Mode v2 plan runs through the controller (orchestra.js makePlanRun)
// with faked git/tabs: ONE topic split, topic -> critique -> synthesis
// packages started right away (Q6), workers locked down on the plan profile,
// luna-plan/ branches, branches-only integration.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const { normalizeStoredPlan } = require('../src/orchestraSupervisor');
const { planAllowedTools } = require('../src/orchestraPlanRunLaunch');

const TOPICS = [
  { slug: 'auth-flow', question: 'How should sign-in work?' },
  { slug: 'data-model', question: 'What tables do we need?' },
];
const PLAN_PROFILE = { id: 'freellm-auto', command: 'claude', env: { ANTHROPIC_MODEL: 'auto:easy' } };

function setup({ split = { ok: true, raw: { topics: TOPICS }, costUsd: 0.1 }, profile = PLAN_PROFILE, extraDeps = {} } = {}) {
  const log = { worktreeOpts: [], sessions: [], splits: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => {
      throw new Error('a plan run never calls the build planner');
    },
    runTopicSplit: async (args) => {
      log.splits.push(args);
      return split;
    },
    planProfile: () => profile,
    planMcpConfigPath: () => '/cfg/luna-plan-mcp.json',
    addWorktree: async (repo, name, opts) => {
      log.worktreeOpts.push(opts);
      return { ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `${opts.branchPrefix || 'luna/'}${name}` };
    },
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
    ...extraDeps,
  });
  return { orch, log };
}

const ctx = (over = {}) => ({ projectId: 'p1', repoPath: '/repo', env: { E: '1' }, request: 'Plan the auth redesign', planner: 'free', planRunRequest: true, ...over });

test('a plan run starts right away: topic packages first, locked down on the plan profile', async (t) => {
  const { orch, log } = setup();
  t.after(() => orch.kill && orch.kill());
  const res = await orch.makePlanRun(ctx());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(log.splits[0], { cwd: '/repo', env: { E: '1' }, request: 'Plan the auth redesign', planner: 'free' });

  const v = res.plan;
  assert.equal(v.started, true);
  assert.deepEqual(v.packages.map((p) => p.id), ['auth-flow', 'data-model', 'critique', 'synthesis']);
  assert.ok(v.planRun, 'the board gets the plan-run view');
  assert.match(v.planRun.runSlug, /^plan-the-auth-redesign-/);
  assert.equal(v.planRun.phases.topics.total, 2);

  // Only the two topic packages start; critique waits for them.
  assert.equal(log.sessions.length, 2);
  for (const opts of log.worktreeOpts) assert.equal(opts.branchPrefix, 'luna-plan/');
  for (const s of log.sessions) {
    assert.equal(s.profileId, 'freellm-auto');
    assert.match(s.branch, /^luna-plan\//);
    assert.equal(s.task.permissionMode, 'dontAsk');
    assert.deepEqual(s.task.allowedTools, planAllowedTools(v.planRun.runSlug));
    assert.deepEqual(s.task.lockdown, { runSlug: v.planRun.runSlug, mcpConfigPath: '/cfg/luna-plan-mcp.json' });
    assert.equal(s.task.model, null);
  }
});

test('no plan profile, or one that decides permissions, is refused before the split', async () => {
  let s = setup({ profile: null });
  assert.deepEqual(await s.orch.makePlanRun(ctx()), { ok: false, error: 'noPlanProfile' });
  assert.equal(s.log.splits.length, 0);
  s = setup({ profile: { ...PLAN_PROFILE, command: 'claude --dangerously-skip-permissions' } });
  assert.deepEqual(await s.orch.makePlanRun(ctx()), { ok: false, error: 'noLockdown' });
  assert.equal(s.log.splits.length, 0);
  assert.equal(s.log.sessions.length, 0);
});

test('bad topics fail without starting anything', async () => {
  const { orch, log } = setup({ split: { ok: true, raw: { topics: TOPICS.slice(0, 1) }, costUsd: 0 } });
  const res = await orch.makePlanRun(ctx());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'badTopics');
  assert.equal(log.sessions.length, 0);
});

test('a spent window: the Claude planner waits, a free planner just fails', async () => {
  const limit = { ok: false, error: 'limit', detail: 'usage limit reached' };
  const free = setup({ split: limit });
  assert.deepEqual(await free.orch.makePlanRun(ctx({ planner: 'free' })), limit);
  assert.equal(free.orch.planWait(), null);

  const claude = setup({ split: limit });
  const res = await claude.orch.makePlanRun(ctx({ planner: 'claude' }));
  assert.equal(res.error, 'waiting');
  assert.ok(claude.orch.planWait());
  claude.orch.cancelPlanWait();
});

test('a second plan run is refused while the first one works', async (t) => {
  const { orch } = setup();
  t.after(() => orch.kill && orch.kill());
  assert.equal((await orch.makePlanRun(ctx())).ok, true);
  assert.deepEqual(await orch.makePlanRun(ctx()), { ok: false, error: 'runActive' });
});

test('a stored plan run keeps its plan-run block and stays branches-only after a restart', () => {
  const restored = normalizeStoredPlan({
    id: 'p1',
    repoPath: process.cwd(),
    profileId: 'freellm-auto',
    integrationMode: 'merge',
    planRun: { runSlug: 'auth-x1', request: 'r', planner: 'free', topics: TOPICS, saved: [], flagged: [] },
    packages: [
      {
        id: 'auth-flow',
        title: 'T',
        todoAts: [],
        prompt: 'p',
        files: [],
        dependsOn: [],
        state: 'pending',
        branch: 'luna-plan/auth-flow',
        planRun: { runSlug: 'auth-x1', role: 'topic', topic: 'auth-flow', outputPath: 'docs/plans/auth-x1/auth-flow.md' },
      },
    ],
  });
  assert.equal(restored.integrationMode, 'branches');
  assert.equal(restored.planRun.runSlug, 'auth-x1');
  assert.deepEqual(restored.packages[0].planRun, { runSlug: 'auth-x1', role: 'topic', topic: 'auth-flow', outputPath: 'docs/plans/auth-x1/auth-flow.md' });
});

// --- finish: plan guard, doc copies, PLAN.md sizing --------------------------

const turn = (text) => JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** A started plan run whose finish / doc / sizing deps are scripted per package. */
async function finishing({ finish = {}, sizing = [] } = {}) {
  const alive = new Set();
  const out = { finishes: [], saved: [], pasted: [], sizingCalls: [] };
  const sizingQueue = [...sizing];
  const s = setup({
    extraDeps: {
      createSession: (opts) => {
        const id = `s${s.log.sessions.length + 1}`;
        alive.add(id);
        s.log.sessions.push({ ...opts, id });
        return { id };
      },
      sessionAlive: (id) => alive.has(id),
      closeSession: (id) => alive.delete(id),
      writePty: (id, text) => {
        out.pasted.push([id, text]);
        return alive.has(id);
      },
      finishPackage: async (p) => {
        out.finishes.push(p.id);
        return finish[p.id] ? finish[p.id]() : { ok: true, headSha: `${p.id}aaaaaaa` };
      },
      planDocs: {
        read: (p) => `# ${p.id}\n`,
        save: (planId, file, text) => (out.saved.push([planId, file, text]), true),
        sizing: (text, opts) => {
          out.sizingCalls.push(opts);
          return sizingQueue.shift() || { action: 'accept' };
        },
      },
      setTimer: () => ({}),
      clearTimer: () => {},
      sleep: async () => {},
    },
  });
  const res = await s.orch.makePlanRun(ctx());
  assert.equal(res.ok, true, JSON.stringify(res));
  // The latest tab whose luna-plan/ branch names the package.
  const sessionOf = (id) => s.log.sessions.filter((x) => x.branch.includes(id)).at(-1).id;
  const done = async (id) => {
    s.orch.onTurnEnd(sessionOf(id), turn(`LUNA_DONE ${id}`));
    await flush();
  };
  const pkgView = (id) => s.orch.view().packages.find((p) => p.id === id);
  return { ...s, out, done, pkgView };
}

test('a plan-guard failure stalls the package with its reason on the board', async () => {
  const s = await finishing({ finish: { 'auth-flow': () => ({ ok: false, stage: 'planGuard', reason: 'outsidePlanFolder', detail: 'src/x.js' }) } });
  await s.done('auth-flow');
  const p = s.pkgView('auth-flow');
  assert.equal(p.state, 'stalled');
  assert.equal(p.error, 'outsidePlanFolder');
  assert.deepEqual(s.orch.view().planRun.stalls, [{ id: 'auth-flow', reason: 'outsidePlanFolder', detail: 'src/x.js' }]);
  assert.deepEqual(s.out.saved, [], 'a refused doc is never copied');
});

test('pushed docs are copied for the report; PLAN.md gets one split round, then flags', async () => {
  const flagged = [{ index: 0, text: 'Rewrite main', reasons: ['touches ~3383 lines'] }];
  const s = await finishing({ sizing: [{ action: 'split', brief: 'Split these tasks. Commit the change.' }, { action: 'flag', flagged }] });
  await s.done('auth-flow');
  await s.done('data-model');
  assert.equal(s.pkgView('auth-flow').state, 'pushed');
  assert.deepEqual(s.out.saved.map(([, file]) => file), ['auth-flow.md', 'data-model.md']);
  assert.equal(s.pkgView('critique').state, 'launched', 'critique starts once every topic is pushed');

  await s.done('critique');
  assert.equal(s.pkgView('synthesis').state, 'launched');
  await s.done('synthesis');
  // First sizing pass: the split goes back to the live synthesis worker.
  assert.equal(s.pkgView('synthesis').state, 'launched');
  const [, pasted] = s.out.pasted.at(-1);
  assert.match(pasted, /LunaCore commits it for you/);
  assert.match(pasted, /LUNA_DONE synthesis/);
  assert.equal(s.out.sizingCalls[0].splitsSent, 0);

  await s.done('synthesis');
  assert.equal(s.out.sizingCalls[1].splitsSent, 1);
  assert.equal(s.pkgView('synthesis').state, 'pushed');
  const pr = s.orch.view().planRun;
  assert.deepEqual(pr.flagged, flagged);
  assert.equal(pr.ready, true);
  assert.deepEqual(pr.docs.map((d) => d.file), ['auth-flow.md', 'data-model.md', 'CRITIQUE.md', 'PLAN.md']);
});
