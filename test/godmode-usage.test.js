// ============================================================================
// God Mode token usage carried to Luna's Work (src/orchestraUsage.js): the
// planner's and the reviewer's `claude -p` envelopes and the worker tabs'
// transcript totals are summed per source and per model on the run's board
// view (`usage`), and a Luna's Work build books that sum under its builder
// role (src/lunasworkUsage.js godModeUsage -> the ledger's byRole.builder).
// Additive only: a result without token data looks exactly as before.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const gm = require('../src/orchestraUsage.js');
const { parsePlannerOutput, runPlanner } = require('../src/orchestraPlan.js');
const { runReview } = require('../src/orchestraReview.js');
const { createOrchestra } = require('../src/orchestra.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');
const lw = require('../src/lunasworkUsage.js');
const { restoreRun } = require('../src/lunasworkRun.js');

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';
const n = (calls, i, o, cr, cw, cost = 0) => ({ calls, inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw, costUsd: cost });

// The planner's envelope: mostly Opus, plus the CLI's small Haiku side call.
const PLANNER_ENV = {
  type: 'result',
  is_error: false,
  structured_output: { packages: [], notes: '' },
  total_cost_usd: 1.5,
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
  modelUsage: {
    [OPUS]: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 1.4 },
    [HAIKU]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 },
  },
};
const PLANNER_USAGE = {
  ...n(1, 110, 45, 1000, 200, 1.5),
  byModel: { [OPUS]: n(0, 100, 40, 1000, 200, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1) },
};

// ---- envelopes and transcripts -> Usage --------------------------------------------

test('usageFromEnvelope: totals are the per-model split summed; the cost is the CLI total', () => {
  assert.deepEqual(gm.usageFromEnvelope(PLANNER_ENV, 'opus'), PLANNER_USAGE);
});

test('usageFromEnvelope without modelUsage files the usage under the call model', () => {
  const env = { total_cost_usd: 0.2, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 50 } };
  assert.deepEqual(gm.usageFromEnvelope(env, 'sonnet'), { ...n(1, 7, 3, 50, 0, 0.2), byModel: { sonnet: n(0, 7, 3, 50, 0, 0.2) } });
  assert.deepEqual(gm.usageFromEnvelope(env), { ...n(1, 7, 3, 50, 0, 0.2), byModel: {} });
});

test('usageFromEnvelope: no numbers = null; junk and hostile keys are dropped, never invented', () => {
  for (const bad of [null, 'x', 7, [], {}, { usage: {} }, { usage: { input_tokens: -5 }, total_cost_usd: -1 }]) {
    assert.equal(gm.usageFromEnvelope(bad, 'opus'), null);
  }
  const u = gm.usageFromEnvelope({ modelUsage: { __proto__: { inputTokens: 9 }, 'a b': { inputTokens: 9 }, [OPUS]: { inputTokens: 'x', outputTokens: 4 } } }, 'opus');
  assert.deepEqual(u, { ...n(1, 0, 4, 0, 0), byModel: { [OPUS]: n(0, 0, 4, 0, 0) } });
  assert.equal(Object.getPrototypeOf(u.byModel), Object.prototype);
});

test('usageFromTranscript: a tab reports tokens per model, no calls and no cost', () => {
  const byModel = new Map([[SONNET, { input: 30, output: 20, cacheRead: 500, cacheWrite: 60 }], ['<synthetic>', { input: 5 }]]);
  assert.deepEqual(gm.usageFromTranscript(byModel), { ...n(0, 30, 20, 500, 60), byModel: { [SONNET]: n(0, 30, 20, 500, 60) } });
  assert.deepEqual(gm.usageFromTranscript({ [SONNET]: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }).inputTokens, 1);
  assert.deepEqual(gm.usageFromTranscript(null), gm.emptyUsage());
});

test('addUsage sums totals and each model; inputs are not mutated', () => {
  const a = gm.usageFromEnvelope(PLANNER_ENV);
  const before = JSON.stringify(a);
  const sum = gm.addUsage(a, { ...n(0, 30, 20, 500, 60), byModel: { [SONNET]: n(0, 30, 20, 500, 60), [OPUS]: n(0, 1, 1, 1, 1) } });
  assert.deepEqual(sum, {
    ...n(1, 140, 65, 1500, 260, 1.5),
    byModel: { [OPUS]: n(0, 101, 41, 1001, 201, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1), [SONNET]: n(0, 30, 20, 500, 60) },
  });
  assert.equal(JSON.stringify(a), before);
});

// ---- the run's book --------------------------------------------------------------------

test('usage book: headless calls add up, a tab keeps its latest reading, a restarted transcript is banked', () => {
  const book = gm.createUsageBook();
  assert.equal(book.snapshot('p1'), null, 'no run yet');
  book.begin('p1');
  assert.equal(book.snapshot('p1'), null, 'nothing reported yet');
  book.add('planner', PLANNER_USAGE);
  book.add('nonsense', PLANNER_USAGE);
  book.add('review', { ...n(1, 4, 2, 0, 0, 0.05), byModel: { sonnet: n(0, 4, 2, 0, 0, 0.05) } });
  // Running totals: the second reading replaces the first, it is not added to it.
  book.setSession('s1', { [SONNET]: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } });
  book.setSession('s1', { [SONNET]: { input: 30, output: 20, cacheRead: 500, cacheWrite: 60 } });
  book.setSession('s2', { [OPUS]: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
  const snap = book.snapshot('p1');
  assert.deepEqual(Object.keys(snap.bySource).sort(), ['planner', 'review', 'workers']);
  assert.deepEqual(snap.bySource.workers, { ...n(0, 37, 23, 500, 60), byModel: { [SONNET]: n(0, 30, 20, 500, 60), [OPUS]: n(0, 7, 3, 0, 0) } });
  assert.deepEqual(snap.total, {
    ...n(2, 151, 70, 1500, 260, 1.55),
    byModel: { [OPUS]: n(0, 107, 43, 1000, 200, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1), sonnet: n(0, 4, 2, 0, 0, 0.05), [SONNET]: n(0, 30, 20, 500, 60) },
  });
  // The tab's transcript started over (/clear, account resume): the old reading still counts.
  book.setSession('s1', { [SONNET]: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(book.snapshot('p1').bySource.workers.byModel[SONNET], n(0, 32, 21, 500, 60));
  assert.equal(book.snapshot('other'), null, 'another plan id never reads this run');
  book.begin('p2');
  assert.equal(book.snapshot('p2'), null, 'a new run starts empty');
});

// ---- the headless calls report it ---------------------------------------------------------

const execWith = (envelope) => (file, args, opts, cb) => {
  setImmediate(() => cb(null, JSON.stringify(envelope)));
  return { stdin: { on() {}, end() {} } };
};

test('parsePlannerOutput / runPlanner: usage rides along; an envelope without numbers is unchanged', async () => {
  assert.deepEqual(parsePlannerOutput(JSON.stringify(PLANNER_ENV), 'opus').usage, PLANNER_USAGE);
  // Exactly the old shape when the CLI reports no tokens and no cost.
  assert.deepEqual(parsePlannerOutput(JSON.stringify({ structured_output: { a: 1 } })), { ok: true, raw: { a: 1 }, costUsd: null });
  assert.equal('usage' in parsePlannerOutput(JSON.stringify({ is_error: true, result: 'boom', usage: PLANNER_ENV.usage })), false);
  const res = await runPlanner({ isDirImpl: () => true, cwd: 'C:/repo', env: {}, openTodos: [], execImpl: execWith(PLANNER_ENV) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.usage, PLANNER_USAGE);
});

test('runReview: the verdict is as before, plus the usage filed under sonnet', async () => {
  const env = { structured_output: { verdict: 'pass', reasons: [] }, total_cost_usd: 0.05, usage: { input_tokens: 4, output_tokens: 2 } };
  const res = await runReview({ cwd: '/wt/a', env: {}, prompt: 'p', execImpl: execWith(env) });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'pass');
  assert.equal(res.costUsd, 0.05);
  assert.deepEqual(res.usage, { ...n(1, 4, 2, 0, 0, 0.05), byModel: { sonnet: n(0, 4, 2, 0, 0, 0.05) } });
  const bare = await runReview({ cwd: '/wt/a', env: {}, prompt: 'p', execImpl: execWith({ structured_output: { verdict: 'pass', reasons: [] } }) });
  assert.equal('usage' in bare, false);
});

// ---- the controller: view().usage and the settled result -----------------------------------

const pkg = (id, todoAts, model) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model });
const TODOS = [
  { at: 1, text: 'quote screen', done: false },
  { at: 2, text: 'pdf export', done: false },
];

function controller(plannerResult, extra = {}) {
  let seq = 0;
  const alive = new Set();
  const state = { saved: null, settled: null };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => TODOS,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => plannerResult,
    addWorktree: async (_repo, name) => {
      const root = path.join(path.resolve('/wt'), name);
      return { ok: true, root, cwd: root, branch: `luna/${name}` };
    },
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    sessionAlive: (id) => alive.has(id),
    writePty: (id) => alive.has(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    createPr: async () => ({ ok: true, url: 'https://github.com/o/r/pull/1' }),
    removeWorktree: async () => ({ ok: true }),
    sleep: async () => {},
    saveState: (s) => {
      state.saved = s;
    },
    ...extra,
  });
  return { orch, state };
}

const PLAN_RAW = { packages: [pkg('a', [1], 'sonnet'), pkg('b', [2], 'opus')], notes: '' };
const planCtx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };

test('a plan without token data has usage null and is otherwise the plan it always was', async () => {
  const { orch, state } = controller({ ok: true, raw: PLAN_RAW, costUsd: 0.4 });
  const res = await orch.makePlan(planCtx);
  assert.equal(res.ok, true);
  assert.equal(res.plan.usage, null);
  assert.equal(res.plan.costUsd, 0.4);
  assert.equal('usage' in state.saved, false, 'tokens are not written with the stored run');
});

test('view().usage: planner envelope + worker tabs, per source and per model', async () => {
  const { orch } = controller({ ok: true, raw: PLAN_RAW, costUsd: 1.5, usage: PLANNER_USAGE });
  const made = await orch.makePlan(planCtx);
  assert.deepEqual(made.plan.usage, { total: PLANNER_USAGE, bySource: { planner: PLANNER_USAGE } });

  await orch.launch({ planId: made.plan.id });
  const [a, b] = orch.view().packages;
  assert.ok(a.sessionId && b.sessionId, 'both workers have a tab');
  assert.equal(orch.onSessionUsage(a.sessionId, { [SONNET]: { input: 30, output: 20, cacheRead: 500, cacheWrite: 60 } }), true);
  assert.equal(orch.onSessionUsage(b.sessionId, { [OPUS]: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } }), true);
  // A tab that is not this run's is never booked.
  assert.equal(orch.onSessionUsage('someone-elses-tab', { [OPUS]: { input: 9999, output: 9999 } }), false);

  const usage = orch.view().usage;
  assert.deepEqual(usage.bySource.planner, PLANNER_USAGE);
  assert.deepEqual(usage.bySource.workers, { ...n(0, 37, 23, 500, 60), byModel: { [SONNET]: n(0, 30, 20, 500, 60), [OPUS]: n(0, 7, 3, 0, 0) } });
  // The total is the sum of the calls that reported tokens, the split kept:
  // the Opus planner and the Sonnet / Opus workers stay apart.
  assert.deepEqual(usage.total, {
    ...n(1, 147, 68, 1500, 260, 1.5),
    byModel: { [OPUS]: n(0, 107, 43, 1000, 200, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1), [SONNET]: n(0, 30, 20, 500, 60) },
  });
});

test("onRunSettled's result carries the usage (the plan view Luna's Work reads)", async () => {
  const { orch } = controller({ ok: true, raw: { packages: [pkg('a', [1], 'sonnet')], notes: '' }, costUsd: 1.5, usage: PLANNER_USAGE });
  let settled = null;
  const made = await orch.makePlan({ ...planCtx, cards: [1], onRunSettled: (r) => { settled = r; } });
  await orch.launch({ planId: made.plan.id });
  const { sessionId } = orch.view().packages[0];
  orch.onSessionUsage(sessionId, { [SONNET]: { input: 30, output: 20, cacheRead: 500, cacheWrite: 60 } });
  orch.onTurnEnd(sessionId, JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'LUNA_DONE a' }] } }));
  for (let i = 0; i < 200 && !settled; i += 1) await new Promise(setImmediate);
  assert.ok(settled, 'the run settled');
  assert.deepEqual(settled.plan.usage.total, {
    ...n(1, 140, 65, 1500, 260, 1.5),
    byModel: { [OPUS]: n(0, 100, 40, 1000, 200, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1), [SONNET]: n(0, 30, 20, 500, 60) },
  });
});

test('the registry offers a tab reading to every run; only the owner books it', async () => {
  const made = new Map();
  const registry = createOrchestraRegistry({
    makeController: (projectId) => {
      const c = controller({ ok: true, raw: { packages: [pkg('a', [1], 'sonnet')], notes: '' }, costUsd: 0, usage: PLANNER_USAGE }).orch;
      made.set(projectId, c);
      return c;
    },
  });
  const one = registry.ensure('one');
  const two = registry.ensure('two');
  const p1 = await one.makePlan({ ...planCtx, projectId: 'one', repoPath: '/repo1' });
  await two.makePlan({ ...planCtx, projectId: 'two', repoPath: '/repo2' });
  await one.launch({ planId: p1.plan.id });
  registry.onSessionUsage(one.view().packages[0].sessionId, { [SONNET]: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(one.view().usage.bySource.workers.byModel[SONNET], n(0, 30, 20, 0, 0));
  assert.equal('workers' in two.view().usage.bySource, false);
});

// ---- Luna's Work: the builder role -----------------------------------------------------

const GM_TOTAL = {
  ...n(1, 147, 68, 1500, 260, 1.5),
  byModel: { [OPUS]: n(0, 107, 43, 1000, 200, 1.4), [HAIKU]: n(0, 10, 5, 0, 0, 0.1), [SONNET]: n(0, 30, 20, 500, 60) },
};

test('godModeUsage: the settled plan view -> the builder usage; no token data = the planner cost as before', () => {
  assert.deepEqual(lw.godModeUsage({ costUsd: 1.5, usage: { total: GM_TOTAL, bySource: {} } }), GM_TOTAL);
  // Worker tokens only (a planner without numbers): tokens booked, the cost stays the CLI's.
  const workersOnly = { ...n(0, 30, 20, 500, 60), byModel: { [SONNET]: n(0, 30, 20, 500, 60) } };
  assert.deepEqual(lw.godModeUsage({ costUsd: 0.4, usage: { total: workersOnly } }), { ...workersOnly, calls: 1, costUsd: 0.4 });
  assert.deepEqual(lw.godModeUsage({ costUsd: 4.43 }), n(1, 0, 0, 0, 0, 4.43));
  assert.deepEqual(lw.godModeUsage({ costUsd: 4.43, usage: null }), n(1, 0, 0, 0, 0, 4.43));
  for (const nothing of [null, undefined, 'x', {}, { costUsd: 0 }, { usage: { total: {} } }]) assert.equal(lw.godModeUsage(nothing), null);
});

test("a Luna's Work iteration with a build: byRole.builder holds God Mode's tokens and the per-model split", () => {
  const meter = lw.createUsageMeter();
  // What lunasworkWiring's build() books when the God Mode run settles.
  meter.add('builder', lw.godModeUsage({ costUsd: 1.5, usage: { total: GM_TOTAL } }));
  const ledger = lw.closePhase(null, { iteration: 3, phase: 'building', startedAt: 1000, at: 61000, entries: meter.drain() });

  const { byModel, ...numbers } = ledger.byRole.builder;
  assert.deepEqual(numbers, n(1, 147, 68, 1500, 260, 1.5));
  assert.deepEqual(byModel, GM_TOTAL.byModel);
  assert.equal(numbers.inputTokens, byModel[OPUS].inputTokens + byModel[HAIKU].inputTokens + byModel[SONNET].inputTokens);
  assert.deepEqual(ledger.iterations[0].byRole.builder, ledger.byRole.builder);
  assert.equal(ledger.total.inputTokens, 147);

  // A second build adds to it, model by model.
  meter.add('builder', lw.godModeUsage({ costUsd: 0.5, usage: { total: { ...n(1, 10, 10, 0, 0, 0.5), byModel: { [SONNET]: n(0, 10, 10, 0, 0, 0.5) } } } }));
  const next = lw.closePhase(ledger, { iteration: 4, phase: 'building', startedAt: 1000, at: 2000, entries: meter.drain() });
  assert.deepEqual(next.byRole.builder.byModel[SONNET], n(0, 40, 30, 500, 60, 0.5));
  assert.equal(next.byRole.builder.inputTokens, 157);
  assert.equal(next.byRole.builder.costUsd, 2);

  // The split survives the stored run (config/lunaswork.local.json) and a restart.
  const stored = JSON.parse(JSON.stringify(next));
  assert.deepEqual(lw.cleanLedger(stored), next);
  const run = restoreRun({ id: 'run-1', projectId: 'p', repoPath: path.resolve('/repo'), phase: 'building', iteration: 4, usage: stored });
  if (run) assert.deepEqual(run.usage.byRole.builder, next.byRole.builder);
});

test('roles without a per-model split keep the exact old Usage shape', () => {
  const plain = { calls: 1, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 };
  assert.deepEqual(lw.addUsage(plain, plain), { calls: 2, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 });
  assert.equal('byModel' in lw.cleanUsage(plain), false);
  assert.equal('byModel' in lw.cleanUsage({ ...plain, byModel: { '__proto__': { inputTokens: 1 }, bad: 'x' } }), false);
});
