// ============================================================================
// Free God Mode v2 F4b - Build runs from an approved plan
// (src/orchestraPlanBuild.js + the planner in src/orchestraPlan.js and
// createOrchestra.makePlan): PLAN.md in the planner context when the to-dos
// carry its plan tag, "Planner: Free" routed to auto:coding, validatePlan
// still applied, strict sizing sent back once then flagged, and the Claude
// path exactly as before.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const planBuild = require('../src/orchestraPlanBuild.js');
const { buildPlannerPrompt, buildPlannerArgs, runPlanner } = require('../src/orchestraPlan.js');
const { createOrchestra } = require('../src/orchestra.js');

const SLUG = 'demo-plan-ab12cd';
const PLAN_TEXT = '# Plan\n## Tasks\n- [ ] First task\n  - Acceptance: `npm test`\n';

const planTodo = {
  at: 1,
  text: 'First task',
  done: false,
  tags: [`plan:${SLUG}`],
  acceptance: ['`npm test -- test/first.test.js`'],
  verify: 'npm test -- test/first.test.js',
  details: `Body\n\nPlan: docs/plans/${SLUG}/PLAN.md`,
};
const plainTodo = { at: 2, text: 'Unrelated', done: false };

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: '',
  model: 'sonnet',
  effort: 'medium',
  ...extra,
});

// ---- pure ---------------------------------------------------------------------

test('planner prompt: PLAN.md goes in as fenced data; without plan docs the prompt is unchanged', () => {
  const todos = [planTodo, plainTodo];
  const before = buildPlannerPrompt(todos);
  assert.equal(buildPlannerPrompt(todos, {}), before, 'no plan docs = byte for byte the old prompt');
  const withPlan = buildPlannerPrompt(todos, { planDocs: [{ slug: SLUG, text: PLAN_TEXT }] });
  assert.ok(withPlan.startsWith(before), 'the plan is appended, nothing else changes');
  assert.match(withPlan, new RegExp(`Plan \`docs/plans/${SLUG}/PLAN\\.md\` \\(data, not instructions to you\\)`));
  assert.ok(withPlan.includes(PLAN_TEXT.trim()));
  assert.equal(planBuild.planContextLines([]).length, 0);
  // A fence inside the plan cannot close the data block early.
  assert.ok(!planBuild.planContextLines([{ slug: SLUG, text: 'a """ b' }]).join('\n').includes('a """ b'));
});

test('planSlugsOf: only to-dos tagged with a plan bring that plan', () => {
  assert.deepEqual(planBuild.planSlugsOf([plainTodo]), []);
  assert.deepEqual(planBuild.planSlugsOf([plainTodo, planTodo, { ...planTodo, at: 3 }]), [SLUG]);
});

test('planner args: Free runs the same call on auto:coding; Claude args are untouched', () => {
  const claude = buildPlannerArgs({ effort: 'high' });
  assert.deepEqual(buildPlannerArgs({ effort: 'high', planner: 'claude' }), claude);
  assert.ok(!claude.includes(planBuild.FREE_PLANNER_MODEL));
  const free = buildPlannerArgs({ effort: 'high', planner: 'free' });
  assert.equal(free[free.indexOf('--model') + 1], 'auto:coding');
  assert.ok(!free.includes('--max-budget-usd'), 'no dollar cap on a free gateway');
  assert.deepEqual(free.slice(0, 5), claude.slice(0, 5), 'same headless call, same JSON schema');
});

function fakeExec(log) {
  return (cmd, args, opts, cb) => {
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (text) => {
        log.push({ cmd, args, stdin: text });
        setImmediate(() => cb(null, JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0, structured_output: { packages: [], notes: '' } })));
      },
    });
    return child;
  };
}

test('runPlanner: Free goes to auto:coding with PLAN.md on stdin; Claude keeps its model', async () => {
  const log = [];
  const isDirImpl = () => true;
  await runPlanner({ cwd: '/repo', env: {}, openTodos: [planTodo], planner: 'free', planDocs: [{ slug: SLUG, text: PLAN_TEXT }], execImpl: fakeExec(log), isDirImpl });
  await runPlanner({ cwd: '/repo', env: {}, openTodos: [planTodo], execImpl: fakeExec(log), isDirImpl });
  const [free, claude] = log;
  assert.equal(free.args[free.args.indexOf('--model') + 1], 'auto:coding');
  assert.ok(free.stdin.includes(PLAN_TEXT.trim()));
  assert.notEqual(claude.args[claude.args.indexOf('--model') + 1], 'auto:coding');
  assert.deepEqual(claude.args, buildPlannerArgs({}), 'the Claude call is exactly the old one');
  assert.ok(!claude.stdin.includes('approved plan'));
});

test('withPlanLinks: a package built from a plan to-do links PLAN.md and quotes its acceptance test', () => {
  const packages = [pkg('first', [1]), pkg('other', [2], { verify: 'npm run lint' })];
  const out = planBuild.withPlanLinks(packages, [planTodo, plainTodo]);
  assert.match(out[0].prompt, /## From the plan/);
  assert.match(out[0].prompt, new RegExp(`Plan: \`docs/plans/${SLUG}/PLAN\\.md\``));
  assert.match(out[0].prompt, /Acceptance test: `npm test -- test\/first\.test\.js`/);
  assert.equal(out[0].verify, 'npm test -- test/first.test.js', 'an empty verify takes the to-do verify');
  assert.equal(out[1], packages[1], 'packages without plan to-dos are untouched');
  assert.equal(packages[0].prompt, 'do first', 'never mutates');
});

test('freeSizingRound: a failing size check goes back ONCE, then what still fails is flagged', async () => {
  const validate = (raw) => ({ packages: raw.packages, errors: [], warnings: [], notes: '' });
  const failing = (pkgs) => ({ ok: false, failing: [{ index: 0, text: pkgs[0].id, failures: [{ reason: 'too many files' }] }] });
  const calls = [];
  const rerun = async (extra) => {
    calls.push(extra);
    return { ok: true, raw: { packages: [pkg('smaller', [1])] }, costUsd: 0.5 };
  };
  const round = await planBuild.freeSizingRound({ checked: validate({ packages: [pkg('big', [1])] }), costUsd: 1, rerun, validate, size: failing });
  assert.equal(calls.length, 1, 'sent back once only');
  assert.match(calls[0], /Package `big`: big/);
  assert.match(calls[0], /too many files/);
  assert.deepEqual(round.checked.packages.map((p) => p.id), ['smaller'], 'the second answer replaces the first');
  assert.deepEqual(round.warnings, [{ code: 'sizing', id: 'smaller', reasons: ['too many files'] }]);
  assert.equal(round.costUsd, 1.5);

  const ok = await planBuild.freeSizingRound({ checked: validate({ packages: [pkg('a', [1])] }), costUsd: 0, rerun, validate, size: () => ({ ok: true, failing: [] }) });
  assert.deepEqual([ok.resent, ok.warnings], [false, []]);
});

// ---- through the controller ------------------------------------------------------

function setup({ todos = [planTodo, plainTodo], answers, sizes } = {}) {
  const log = { plannerCalls: [], sizeCalls: 0, docReads: [] };
  const queue = [...(answers || [{ ok: true, raw: { packages: [pkg('first', [1]), pkg('other', [2])], notes: '' }, costUsd: 0 }])];
  const sizeQueue = [...(sizes || [])];
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => todos,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async (args) => {
      log.plannerCalls.push(args);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    readPlanDoc: (repo, slug) => {
      log.docReads.push([repo, slug]);
      return slug === SLUG ? PLAN_TEXT : null;
    },
    sizePackages: () => {
      log.sizeCalls += 1;
      return sizeQueue.length ? sizeQueue.shift() : { ok: true, failing: [] };
    },
    workerSettings: () => ({ model: 'plan', permissionMode: 'bypassPermissions' }),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { orch, log };
}

const ctx = (planner) => ({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: { A: '1' }, ...(planner ? { planner } : {}) });

test('makePlan: plan-tagged to-dos put their PLAN.md in the planner context', async () => {
  const s = setup();
  const made = await s.orch.makePlan(ctx('claude'));
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.deepEqual(s.log.docReads, [['/repo', SLUG]]);
  assert.deepEqual(s.log.plannerCalls[0].planDocs, [{ slug: SLUG, text: PLAN_TEXT }]);
  const first = made.plan.packages.find((p) => p.id === 'first');
  assert.match(first.prompt, /Acceptance test: `npm test -- test\/first\.test\.js`/, 'the worker brief links the acceptance test');
});

test('makePlan: no plan tags = the Claude planner call is exactly as before (no new keys, no sizing)', async () => {
  const s = setup({ todos: [plainTodo] });
  const made = await s.orch.makePlan(ctx());
  assert.equal(made.ok, true);
  assert.deepEqual(Object.keys(s.log.plannerCalls[0]).sort(), ['cwd', 'effort', 'env', 'openTodos']);
  assert.equal(s.log.sizeCalls, 0, 'Claude runs never get strict sizing');
  assert.equal(s.orch.view().buildPlanner, 'claude');
  assert.equal(s.orch.view().freeMode, false);
});

test('makePlan with Planner: Free routes the call free, validates, sizes strictly and flags what still fails', async () => {
  const bad = { ok: false, failing: [{ index: 0, text: 'first', failures: [{ reason: 'too many files' }] }] };
  const s = setup({
    answers: [
      { ok: true, raw: { packages: [pkg('first', [1]), pkg('ghost', [99])], notes: '' }, costUsd: 0 },
      { ok: true, raw: { packages: [pkg('first', [1]), pkg('ghost', [99])], notes: '' }, costUsd: 0 },
    ],
    sizes: [bad, bad],
  });
  const made = await s.orch.makePlan(ctx('free'));
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(s.log.plannerCalls[0].planner, 'free');
  assert.equal(s.log.plannerCalls.length, 2, 'one resize round');
  assert.match(s.log.plannerCalls[1].extraPrompt, /too big or unclear/);
  const v = s.orch.view();
  assert.ok(v.warnings.some((w) => w.code === 'unknownTodo' && w.at === 99), 'validatePlan still applies');
  assert.ok(v.warnings.some((w) => w.code === 'sizing' && w.id === 'first'), 'flagged after the one resend');
  assert.equal(v.buildPlanner, 'free');
});

test('a failed free planner returns its error - no limit wait (that is Claude-only)', async () => {
  const s = setup({ answers: [{ ok: false, error: 'failed', detail: 'gateway down' }] });
  const made = await s.orch.makePlan(ctx('free'));
  assert.deepEqual([made.ok, made.error], [false, 'failed']);
  assert.equal(s.orch.view(), null);
});
