// ============================================================================
// Free God Mode v2 Q8 - auto-split of a package that stalled twice in a
// free-planned build run (src/orchestraAutoSplit.js), as pure rules and
// through the controller with git, tabs and the planner faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const split = require('../src/orchestraAutoSplit.js');
const { validatePlan } = require('../src/orchestraPlan.js');
const { createOrchestra } = require('../src/orchestra.js');
const { normalizeStoredPlan } = require('../src/orchestraSupervisor.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  effort: 'medium',
  ...extra,
});

// ---- pure rules ---------------------------------------------------------------

test('shouldAutoSplit: the SECOND stall of a free-planned package splits, the first does not', () => {
  const plan = { buildPlanner: 'free' };
  assert.equal(split.shouldAutoSplit(plan, { stalls: 1 }, 'blocked'), false);
  for (const reason of ['noMarker', 'blocked', 'verifyFailed', 'timeout', 'noCommitsFailed']) {
    assert.equal(split.shouldAutoSplit(plan, { stalls: 2 }, reason), true, reason);
  }
  // The 2 h worker cap stalls with reason 'timeout' - counts like any stall.
  assert.equal(split.shouldAutoSplit(plan, { stalls: 3 }, 'timeout'), true);
  // Machinery / permission stalls are not the task's size.
  for (const reason of ['needsApproval', 'restarted', 'pushFailed', 'noTab']) {
    assert.equal(split.shouldAutoSplit(plan, { stalls: 2 }, reason), false, reason);
  }
});

test('shouldAutoSplit: Claude-planned runs, plan runs and split packages never split', () => {
  assert.equal(split.shouldAutoSplit({}, { stalls: 2 }, 'blocked'), false, 'Claude planner (no buildPlanner)');
  assert.equal(split.shouldAutoSplit({ buildPlanner: 'claude' }, { stalls: 2 }, 'blocked'), false);
  assert.equal(split.shouldAutoSplit({ buildPlanner: 'free', planRun: { runSlug: 'x' } }, { stalls: 2 }, 'blocked'), false);
  const plan = { buildPlanner: 'free' };
  assert.equal(split.shouldAutoSplit(plan, { stalls: 2, splitOf: 'big' }, 'blocked'), false, 'a split part never splits again');
  assert.equal(split.shouldAutoSplit(plan, { stalls: 2, splitInto: ['x', 'y'] }, 'blocked'), false);
  assert.equal(split.shouldAutoSplit(plan, { stalls: 2, splitFailed: true }, 'blocked'), false);
  assert.equal(split.shouldAutoSplit(null, { stalls: 2 }, 'blocked'), false);
});

test('applySplit rewires the graph: dependants depend on every new package, roots inherit the old deps', () => {
  const packages = [
    { id: 'a', dependsOn: [], state: 'pushed' },
    { id: 'big', dependsOn: ['a'], state: 'stalled' },
    { id: 'c', dependsOn: ['big'], state: 'pending' },
    { id: 'd', dependsOn: ['a', 'big'], state: 'pending' },
    { id: 'e', dependsOn: [], state: 'pending' },
  ];
  const fresh = [
    { id: 's1', dependsOn: [], todoAts: [1], prompt: 'p1', files: [], verify: '', title: 's1' },
    { id: 's2', dependsOn: ['s1'], todoAts: [], prompt: 'p2', files: [], verify: '', title: 's2' },
    { id: 's3', dependsOn: [], todoAts: [], prompt: 'p3', files: [], verify: '', title: 's3' },
  ];
  const res = split.applySplit(packages, 'big', fresh, { toRun: (p) => ({ ...p, state: 'pending' }) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ids, ['s1', 's2', 's3']);
  const byId = new Map(res.packages.map((p) => [p.id, p]));
  assert.deepEqual(res.packages.map((p) => p.id), ['a', 'big', 's1', 's2', 's3', 'c', 'd', 'e']);
  assert.deepEqual(byId.get('s1').dependsOn, ['a'], 'a root of the split inherits the stuck package deps');
  assert.deepEqual(byId.get('s2').dependsOn, ['s1'], 'inner deps are kept');
  assert.deepEqual(byId.get('s3').dependsOn, ['a']);
  assert.deepEqual(byId.get('c').dependsOn, ['s1', 's2', 's3'], 'dependants re-pointed');
  assert.deepEqual(byId.get('d').dependsOn, ['a', 's1', 's2', 's3']);
  assert.deepEqual(byId.get('e').dependsOn, [], 'unrelated packages untouched');
  assert.equal(byId.get('e'), packages[4], 'unrelated packages keep their identity');
  assert.deepEqual([byId.get('big').terminal, byId.get('big').splitInto], [true, ['s1', 's2', 's3']]);
  for (const id of res.ids) assert.equal(byId.get(id).splitOf, 'big');
  assert.equal(packages[1].terminal, undefined, 'the input is never mutated');
});

test('applySplit renames ids that already exist in the run', () => {
  const packages = [{ id: 'big', dependsOn: [] }, { id: 'part', dependsOn: [] }];
  const fresh = [
    { id: 'part', dependsOn: [] },
    { id: 'big', dependsOn: ['part'] },
  ];
  const res = split.applySplit(packages, 'big', fresh);
  assert.deepEqual(res.ids, ['part-2', 'big-2']);
  assert.deepEqual(res.packages.find((p) => p.id === 'big-2').dependsOn, ['part-2']);
});

test('checkSplit: only a valid answer with 2-3 packages replaces the package', () => {
  const todos = [{ at: 1, text: 'one' }];
  const raw = (n) => ({ packages: Array.from({ length: n }, (_, i) => pkg(`s${i}`, i === 0 ? [1] : [])), notes: '' });
  assert.equal(split.checkSplit(validatePlan(raw(1), todos)).error, 'tooFew');
  assert.equal(split.checkSplit(validatePlan(raw(2), todos)).ok, true);
  assert.equal(split.checkSplit(validatePlan(raw(3), todos)).ok, true);
  assert.equal(split.checkSplit(validatePlan(raw(4), todos)).error, 'tooMany');
  const cyc = { packages: [pkg('x', [1], { dependsOn: ['y'] }), pkg('y', [], { dependsOn: ['x'] })], notes: '' };
  assert.equal(split.checkSplit(validatePlan(cyc, todos)).error, 'invalid', 'validatePlan errors refuse the split');
});

test('buildSplitRequest carries the brief, the stall reasons and the worktree state', () => {
  const text = split.buildSplitRequest({
    pkg: { id: 'big', title: 'Big one', prompt: 'do everything', files: ['src/a.js'], verify: 'npm test', stallHistory: [{ reason: 'blocked', detail: 'too much' }] },
    reason: 'timeout',
    detail: null,
    worktree: { diffStat: ' src/a.js | 10 +++', status: ' M src/a.js' },
  });
  assert.match(text, /Split this task into 2-3 smaller packages/);
  assert.match(text, /Last stall: timeout/);
  assert.match(text, /blocked: too much/);
  assert.match(text, /do everything/);
  assert.match(text, /src\/a\.js \| 10/);
});

// ---- controller -----------------------------------------------------------------

const FIRST = [pkg('big', [1]), pkg('after', [2], { dependsOn: ['big'] })];
const SPLIT = [pkg('big-a', [1]), pkg('big-b', [], { dependsOn: ['big-a'] })];

function setup({ planner = 'free', splitAnswer = { ok: true, raw: { packages: SPLIT, notes: '' }, costUsd: 0 }, settings } = {}) {
  let seq = 0;
  const log = { sessions: [], events: [], plannerCalls: [], closed: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => [1, 2].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async (args) => {
      log.plannerCalls.push(args);
      if (args.extraPrompt && /split request/.test(args.extraPrompt)) return splitAnswer;
      return { ok: true, raw: { packages: FIRST, notes: '' }, costUsd: 0 };
    },
    freeProfileId: () => 'freellm-chain',
    freePlannerEnv: () => ({ ANTHROPIC_MODEL: 'auto:coding' }),
    sizePackages: () => ({ ok: true, failing: [] }),
    worktreeState: async () => ({ diffStat: ' src/x.js | 3 +', status: '' }),
    addWorktree: async (repo, name, opts) => {
      const branch = `${(opts && opts.branchPrefix) || 'luna/'}${name}`;
      return { ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch };
    },
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}aaaaaaa` }),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => settings || { model: 'plan', permissionMode: 'bypassPermissions' },
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {}, planner };
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  return { orch, log, ctx, flush, view };
}

async function started(opts) {
  const s = setup(opts);
  const made = await s.orch.makePlan(s.ctx);
  assert.equal(made.ok, true, JSON.stringify(made));
  const launched = await s.orch.launch({ planId: made.plan.id });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  return s;
}

test('a free-planned package: first stall resumes, the second splits it and the run goes on', async () => {
  const s = await started();
  assert.equal(s.orch.view().buildPlanner, 'free');
  assert.equal(s.orch.view().freeMode, true, 'a free planner makes a free-only run');

  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED big: one'));
  await s.flush();
  assert.deepEqual([s.view('big').state, s.view('big').autoResumed], ['launched', true], 'first stall: no split');
  assert.equal(s.log.plannerCalls.length, 1);

  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED big: two'));
  assert.equal(s.view('big').splitting, true);
  await s.flush();

  assert.equal(s.log.plannerCalls.length, 2, 'the split went back to the planner');
  const call = s.log.plannerCalls[1];
  assert.equal(call.planner, 'free', 'same planner');
  assert.deepEqual(call.env, { ANTHROPIC_MODEL: 'auto:coding' }, 'same (coding) profile');
  assert.match(call.extraPrompt, /Split this task into 2-3/);
  assert.match(call.extraPrompt, /src\/x\.js \| 3/, 'the worktree state is in the request');
  assert.deepEqual(call.openTodos.map((t) => t.at), [1]);

  const v = s.orch.view();
  const big = s.view('big');
  assert.deepEqual([big.state, big.terminal, big.splitInto, big.splitting], ['stalled', true, ['big-a', 'big-b'], false]);
  assert.deepEqual(s.view('after').dependsOn, ['big-a', 'big-b'], 'dependants re-pointed');
  assert.equal(s.view('after').blockedBy, null, 'nothing waits on the stuck package any more');
  assert.equal(s.view('big-a').splitOf, 'big');
  assert.equal(s.view('big-a').state, 'launched', 'the run continues without asking');
  assert.equal(s.view('big-b').state, 'pending');
  assert.equal(v.settled, false);
  assert.ok(s.log.closed.includes('s2'), 'the stuck worker tab is closed');
  assert.ok(s.log.events.some(([k]) => k === 'autoSplitDone'));
  assert.deepEqual(await s.orch.retry({ planId: v.id, id: 'big' }), { ok: false, error: 'notRetryable' });
});

test('an invalid split answer is refused: the package stays stalled and terminal', async () => {
  const s = await started({ splitAnswer: { ok: true, raw: { packages: [pkg('only', [1])], notes: '' }, costUsd: 0 } });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED big: one'));
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED big: two'));
  await s.flush();
  const big = s.view('big');
  assert.deepEqual([big.state, big.terminal, big.splitInto], ['stalled', true, null]);
  assert.equal(s.view('only'), undefined, 'nothing replaced it');
  assert.deepEqual(s.view('after').dependsOn, ['big']);
  assert.ok(s.log.events.some(([k, d]) => k === 'autoSplitFailed' && d.error === 'tooFew'));
});

test('a Claude-planned run never splits: stall -> resume -> Sonnet -> Opus escalation as today', async () => {
  const s = await started({ planner: 'claude', settings: { model: 'sonnet', permissionMode: 'bypassPermissions' } });
  assert.equal(s.orch.view().buildPlanner, 'claude');
  assert.equal(s.orch.view().freeMode, false);
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED big: one'));
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED big: two'));
  await s.flush();
  assert.deepEqual([s.view('big').state, s.view('big').escalated, s.view('big').model], ['launched', true, 'opus']);
  assert.equal(s.log.plannerCalls.length, 1, 'no split call');
  assert.equal(s.log.events.some(([k]) => k === 'autoSplit'), false);
});

test('split fields and the build planner survive a restart', () => {
  const stored = normalizeStoredPlan({
    id: 'p',
    repoPath: path.resolve('/r'),
    buildPlanner: 'free',
    packages: [
      { id: 'big', state: 'stalled', splitInto: ['big-a', '../x', 'big-b'], splitting: true },
      { id: 'big-a', state: 'pending', splitOf: 'big' },
      { id: 'z', state: 'stalled', splitFailed: true, splitOf: '../evil' },
    ],
  });
  assert.equal(stored.buildPlanner, 'free');
  assert.deepEqual(stored.packages[0].splitInto, ['big-a', 'big-b']);
  assert.equal(stored.packages[0].splitting, undefined, 'a split in flight is not restored');
  assert.equal(stored.packages[1].splitOf, 'big');
  assert.deepEqual([stored.packages[2].splitFailed, stored.packages[2].splitOf], [true, undefined]);
  const claude = normalizeStoredPlan({ id: 'p', repoPath: path.resolve('/r'), packages: [{ id: 'a' }] });
  assert.equal('buildPlanner' in claude, false);
});
