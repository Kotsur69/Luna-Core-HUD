// ============================================================================
// God Mode v2 run controller (ORCHESTRATOR_PLAN.md slice 3): plan -> review ->
// launch, with every side effect (planner, git, tabs, files) faked. Plus the
// launch-command helper that hands a worker tab its brief.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createOrchestra, briefText } = require('../src/orchestra.js');
const { withTaskBrief, isClaudeCommand } = require('../src/launch.js');

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
  assert.equal(first.task.model, 'sonnet');
  const brief = log.briefs.get(first.task.briefPath);
  assert.match(brief, /edited a/, 'the review edit reaches the brief');
  assert.match(brief, /LUNA_DONE a/);
  assert.equal(path.dirname(first.task.briefPath), path.join('/cfg/tasks'));
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

  assert.equal(orch.discard(), true);
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

test('withTaskBrief puts the first message right after the binary and grants the brief folder', () => {
  assert.equal(
    withTaskBrief('claude --allowedTools Read Edit', { briefPath: 'C:\\cfg\\tasks\\a.md', model: 'opus' }),
    "claude 'Your task brief is in the file `C:\\cfg\\tasks\\a.md` - read it first, then carry it out.' --allowedTools Read Edit --add-dir 'C:\\cfg\\tasks' --model opus",
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
