// ============================================================================
// God Mode v2 run controller (DONE_ORCHESTRATOR_PLAN.md slice 3): plan -> review ->
// launch, with every side effect (planner, git, tabs, files) faked. Plus the
// launch-command helper that hands a worker tab its brief.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createOrchestra, briefText, DEFAULT_VERIFY_CONCURRENCY } = require('../src/orchestra.js');
const { withTaskBrief, isClaudeCommand } = require('../src/launch.js');
const { createVerifySemaphore } = require('../src/worktrees.js');
const { runSelfCheck } = require('../src/orchestraSelfCheck.js');

const todo = (at, text) => ({ at, text, done: false });
const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

function setup({ packages, todos = [todo(1, 'one'), todo(2, 'two'), todo(3, 'three')], worktreeFails = [] } = {}) {
  const log = { worktrees: [], briefs: new Map(), sessions: [] };
  let seq = 0;
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => todos,
    dirtyCount: async () => 2,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: 'n' }, costUsd: 0.4 }),
    addWorktree: async (repo, name) => {
      log.worktrees.push([repo, name]);
      if (worktreeFails.some((id) => name.startsWith(id))) return { ok: false, error: 'gitFailed' };
      const root = path.join('/wt', name);
      return { ok: true, root, cwd: root, branch: `luna/${name}` };
    },
    briefDir: () => '/cfg/tasks',
    writeBrief: (file, text) => {
      log.briefs.set(file, text);
      return true;
    },
    createSession: (opts) => {
      log.sessions.push(opts);
      seq += 1;
      return { id: `s${seq}` };
    },
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };
  return { orch, log, ctx };
}

test('makePlan refuses an empty list and returns a view of a validated plan', async () => {
  const empty = setup({ todos: [] });
  assert.deepEqual(await empty.orch.makePlan(empty.ctx), { ok: false, error: 'noTodos' });

  const { orch, ctx } = setup({ packages: [pkg('a', [1]), pkg('b', [2, 3], { dependsOn: ['a'] })] });
  const res = await orch.makePlan(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.plan.dirty, 2);
  assert.equal(res.plan.costUsd, 0.4);
  assert.deepEqual(res.plan.packages.map((p) => [p.id, p.state, p.todos]), [
    ['a', 'pending', ['one']],
    ['b', 'pending', ['two', 'three']],
  ]);
  assert.equal(res.plan.repoPath, undefined, 'the renderer never sees folders');
});

test('Approve launches only dependency-free packages, max 3, each in its own worktree tab', async () => {
  const packages = ['a', 'b', 'c', 'd'].map((id, i) => pkg(id, [i + 1])).concat(pkg('e', [], { dependsOn: ['a'] }));
  const { orch, log, ctx } = setup({ packages, todos: [1, 2, 3, 4].map((n) => todo(n, `t${n}`)) });
  const { plan } = await orch.makePlan(ctx);

  const res = await orch.launch({ planId: plan.id, ids: null, prompts: { a: '  edited a  ', e: 'not launched' } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.plan.packages.map((p) => p.state), ['launched', 'launched', 'launched', 'pending', 'pending']);
  assert.deepEqual(log.worktrees.map(([repo]) => repo), ['/repo', '/repo', '/repo']);

  const first = log.sessions[0];
  assert.equal(first.projectId, 'p1');
  assert.equal(first.profileId, 'claude-cloud');
  assert.match(first.branch, /^luna\/a-/);
  assert.equal(first.task.model, 'opus', 'worker model comes from the settings, opus by default');
  assert.equal(first.task.permissionMode, 'bypassPermissions');
  const brief = log.briefs.get(first.task.briefPath);
  assert.match(brief, /edited a/, 'the review edit reaches the brief');
  assert.match(brief, /LUNA_DONE a/);
  assert.equal(path.dirname(first.task.briefPath), path.join(first.cwd, '.luna-brief'), 'inside the worktree cwd');
  assert.equal(res.plan.packages[4].prompt, 'not launched', 'edits apply to pending packages only when launched');
});

test('launch validates the payload: plan id, errors, nothing to do', async () => {
  const { orch, ctx } = setup({ packages: [pkg('a', [1])], todos: [todo(1, 'x')] });
  const { plan } = await orch.makePlan(ctx);
  assert.equal((await orch.launch({ planId: 'other' })).error, 'noPlan');
  assert.equal((await orch.launch(null)).error, 'noPlan');
  assert.equal((await orch.launch({ planId: plan.id, ids: ['ghost'] })).error, 'nothingToLaunch');

  const cyc = setup({
    packages: [pkg('a', [1], { dependsOn: ['b'] }), pkg('b', [2], { dependsOn: ['a'] })],
  });
  const bad = await cyc.orch.makePlan(cyc.ctx);
  assert.equal((await cyc.orch.launch({ planId: bad.plan.id })).error, 'planErrors');
});

test('a failed worktree marks the package failed; a manual launch retries it', async () => {
  const { orch, log, ctx } = setup({ packages: [pkg('a', [1]), pkg('b', [2])], worktreeFails: ['b'] });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch({ planId: plan.id });
  assert.deepEqual(res.plan.packages.map((p) => [p.id, p.state, p.error]), [
    ['a', 'launched', null],
    ['b', 'failed', 'gitFailed'],
  ]);
  const retry = await orch.launch({ planId: plan.id, ids: ['b', 'a'] });
  assert.equal(retry.ok, true);
  assert.equal(log.worktrees.filter(([, n]) => n.startsWith('a')).length, 1, 'a launched tab is never relaunched');
});

test('a launched run blocks re-planning until discarded; closing its tab shows on the board', async () => {
  const { orch, ctx } = setup({ packages: [pkg('a', [1])], todos: [todo(1, 'x')] });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id });
  assert.equal((await orch.makePlan(ctx)).error, 'runActive');

  assert.equal(orch.onSessionClosed('s9'), false);
  assert.equal(orch.onSessionClosed('s1'), true);
  assert.equal(orch.view().packages[0].state, 'closed');

  // The settled run finalizes (integration, report) - discard waits for it.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(orch.discard(), { ok: true });
  assert.equal(orch.view(), null);
  assert.equal((await orch.makePlan(ctx)).ok, true);
});

test('briefText wraps the planner prompt in LunaCore\'s own contract', () => {
  const text = briefText({ id: 'a', title: 'Fix', prompt: 'Do X.', verify: '' }, 'luna/a-1');
  assert.match(text, /branch `luna\/a-1`/);
  assert.match(text, /Do X\./);
  assert.match(text, /Do not push, merge or switch branches/);
  assert.match(text, /LUNA_BLOCKED a:/);
});

// ---- launch.js: withTaskBrief -------------------------------------------------------

test('withTaskBrief puts the first message right after the binary and adds no --add-dir for the brief', () => {
  assert.equal(
    withTaskBrief('claude --allowedTools Read Edit', { briefPath: 'C:\\cfg\\tasks\\a.md', model: 'opus' }),
    "claude 'Your task brief is in the file `C:\\cfg\\tasks\\a.md` - read it first, then carry it out.' --allowedTools Read Edit --model opus",
  );
});

test('withTaskBrief keeps a profile model and refuses what it cannot carry safely', () => {
  assert.doesNotMatch(withTaskBrief('claude --model glm', { briefPath: '/t/a.md', model: 'opus' }), /--model opus/);
  assert.equal(withTaskBrief('bash', { briefPath: '/t/a.md' }), null);
  assert.equal(withTaskBrief('', { briefPath: '/t/a.md' }), null);
  assert.equal(withTaskBrief('claude', { briefPath: "/t/it's.md" }), null);
  assert.equal(withTaskBrief('claude', { briefPath: '/t/a`b.md' }), null);
  assert.equal(withTaskBrief('claude', { briefPath: '' }), null);
  assert.doesNotMatch(withTaskBrief('claude', { briefPath: '/t/a.md', model: 'x; rm' }), /--model/);
});

test('isClaudeCommand recognises the CLI under its shims only', () => {
  assert.equal(isClaudeCommand('claude'), true);
  assert.equal(isClaudeCommand('"C:\\bin\\claude.exe" --x'), true);
  assert.equal(isClaudeCommand('claude-router'), false);
  assert.equal(isClaudeCommand(''), false);
});

// ---- post-DONE verification semaphore & warm worktree pool -------------------

const turnDone = (id) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `LUNA_DONE ${id}` }] } });

const tick = () => new Promise((r) => setImmediate(r));

test('parallel worktrees serialize post-DONE verification via bounded semaphore (default concurrency 1)', async () => {
  assert.equal(DEFAULT_VERIFY_CONCURRENCY, 1);
  let active = 0;
  let maxActive = 0;
  const started = [];
  const gates = new Map();
  const alive = new Set();
  let seq = 0;

  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [todo(1, 'one'), todo(2, 'two')],
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1]), pkg('b', [2])], notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base123',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      const id = `s${seq}`;
      alive.add(id);
      return { id };
    },
    sessionAlive: (id) => alive.has(id),
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(p.id);
      await new Promise((resolve) => gates.set(p.id, resolve));
      active -= 1;
      return { ok: true, headSha: `head-${p.id}`, files: [] };
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} });
  await orch.launch({ planId: plan.id });

  // Both parallel workers finish at the exact same time.
  orch.onTurnEnd('s1', turnDone('a'));
  orch.onTurnEnd('s2', turnDone('b'));
  await tick();
  await tick();

  assert.deepEqual(started, ['a'], 'second worktree waits behind the first');
  assert.deepEqual(orch.verifyStats(), { active: 1, queued: 1, maxConcurrency: 1 });
  const byId = (id) => orch.view().packages.find((p) => p.id === id);
  assert.equal(byId('a').state, 'finishing');
  assert.equal(byId('b').state, 'finishing');
  assert.equal(byId('b').verifyPhase, 'queued');

  gates.get('a')();
  for (let i = 0; i < 6; i += 1) await tick();
  assert.deepEqual(started, ['a', 'b'], 'b starts once a releases the semaphore');
  assert.equal(byId('a').state, 'pushed');
  assert.equal(byId('b').verifyPhase, 'running');

  gates.get('b')();
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(maxActive, 1);
  assert.equal(byId('b').state, 'pushed');
  assert.deepEqual(orch.verifyStats(), { active: 0, queued: 0, maxConcurrency: 1 });
});

test('verifyConcurrency bounds parallel post-DONE verifications and kill skips queued verifies', async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const gates = new Map();
  const alive = new Set();
  let seq = 0;

  const orch = createOrchestra({
    now: () => 1700000000000,
    verifyConcurrency: 2,
    readTodos: () => [todo(1, 'one'), todo(2, 'two'), todo(3, 'three')],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [pkg('a', [1]), pkg('b', [2]), pkg('c', [3])], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base123',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      const id = `s${seq}`;
      alive.add(id);
      return { id };
    },
    sessionAlive: (id) => alive.has(id),
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(p.id);
      await new Promise((resolve) => gates.set(p.id, resolve));
      active -= 1;
      return { ok: true, headSha: `head-${p.id}`, files: [] };
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} });
  await orch.launch({ planId: plan.id });

  orch.onTurnEnd('s1', turnDone('a'));
  orch.onTurnEnd('s2', turnDone('b'));
  orch.onTurnEnd('s3', turnDone('c'));
  await tick();
  await tick();

  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(orch.verifyStats(), { active: 2, queued: 1, maxConcurrency: 2 });

  // Killing the run while c waits in the queue skips c when a finishes.
  orch.kill();
  gates.get('a')();
  gates.get('b')();
  for (let i = 0; i < 6; i += 1) await tick();

  assert.deepEqual(started, ['a', 'b'], 'queued verify for c never ran after kill');
  assert.equal(maxActive, 2);
  assert.equal(orch.view().packages.find((p) => p.id === 'c').state, 'killed');
  assert.deepEqual(orch.verifyStats(), { active: 0, queued: 0, maxConcurrency: 2 });
});

test('shared verification semaphore serializes orchestra post-DONE verify with orchestraSelfCheck.runSelfCheck', async () => {
  const sharedSem = createVerifySemaphore({ maxConcurrency: 1 });
  let running = 0;
  let peak = 0;
  let releaseWorker;
  const order = [];
  const alive = new Set(['s1']);

  const orch = createOrchestra({
    now: () => 1700000000000,
    verifySemaphore: sharedSem,
    readTodos: () => [todo(1, 'one')],
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1])], notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base123',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    sessionAlive: (id) => alive.has(id),
    finishPackage: async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push('worker:start');
      await new Promise((r) => {
        releaseWorker = r;
      });
      order.push('worker:end');
      running -= 1;
      return { ok: true, headSha: 'head-a', files: [] };
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} });
  await orch.launch({ planId: plan.id });

  orch.onTurnEnd('s1', turnDone('a'));
  await tick();
  await tick();

  const selfCheckPromise = runSelfCheck(
    { root: __dirname, baseSha: null, checkCommand: 'npm test' },
    {
      verifySemaphore: sharedSem,
      verifyImpl: async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push('selfcheck:start');
        await tick();
        order.push('selfcheck:end');
        running -= 1;
        return { ok: true, output: '' };
      },
    },
  );
  await tick();
  assert.deepEqual(order, ['worker:start'], 'self-check waits while worker verification holds the shared semaphore');
  assert.deepEqual(sharedSem.stats(), { active: 1, queued: 1, maxConcurrency: 1 });

  releaseWorker();
  const scRes = await selfCheckPromise;
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(scRes.tests, 'ok');
  assert.equal(peak, 1);
  assert.deepEqual(order, ['worker:start', 'worker:end', 'selfcheck:start', 'selfcheck:end']);
  assert.deepEqual(sharedSem.stats(), { active: 0, queued: 0, maxConcurrency: 1 });
});

test('createOrchestra claims pre-warmed worktrees when deps.worktreePool is provided', async () => {
  const acquired = [];
  let addCalls = 0;
  let seq = 0;
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [todo(1, 'one')],
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1])], notes: '' }, costUsd: 0 }),
    addWorktree: async () => {
      addCalls += 1;
      return { ok: true, root: '/wt/fallback', cwd: '/wt/fallback', branch: 'luna/fallback' };
    },
    worktreePool: {
      acquire: async (repo, name, opts) => {
        acquired.push({ repo, name, opts });
        return { ok: true, root: `/wt/warm-${name}`, cwd: `/wt/warm-${name}`, branch: `luna/${name}`, fromPool: true };
      },
    },
    writeBrief: () => true,
    createSession: () => ({ id: `s${++seq}` }),
  });

  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} });
  const res = await orch.launch({ planId: plan.id });
  assert.equal(res.ok, true);
  assert.equal(addCalls, 0, 'pool.acquire used instead of cold addWorktree');
  assert.equal(acquired.length, 1);
  assert.equal(acquired[0].repo, '/repo');
  assert.match(acquired[0].name, /^a-/);
  assert.equal(acquired[0].opts.linkNodeModules, false, 'God Mode worktrees use own installDeps, never a junction');
});
