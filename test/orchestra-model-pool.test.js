// God Mode "Workers" pool, end to end through createOrchestra():
//   - Planner Opus + Workers [Opus] is today's run byte for byte: the planner
//     prompt / schema / args match the baseline captured from v0.33.0
//     (test/fixtures/planner-opus-baseline.json), and plan + launch settings
//     are the same with and without a one-model pool;
//   - a pool of 2+ models: the planner is offered only those (prompt rules,
//     schema enum), an out-of-pool pick moves to the strongest one, logged;
//   - a mixed run routes every package to its pick: agy on the agy profile
//     with its --model, free on the coding profile, Claude on Claude;
//   - Approve can re-pick the pool; the phone keeps the plan's own.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const planner = require('../src/orchestraPlan');
const { runPlan } = require('../src/orchestraPlanStart');
const sup = require('../src/orchestraSupervisor');
const BASELINE = require('./fixtures/planner-opus-baseline.json');

const e = (model, effort = 'plan') => ({ model, effort });
const OPUS_ONLY = [e('opus')];
const LIVE = [
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
];

const pkg = (id, model, extra = {}) => ({
  id,
  title: id.toUpperCase(),
  todoAts: [extra.at || 1],
  prompt: `do ${id}`,
  files: [`docs/${id}.md`],
  dependsOn: [],
  verify: 'npm test',
  model,
  effort: 'medium',
  modelReason: `${id} reason`,
  ...extra,
});

function fakeAgyModels(list = LIVE) {
  const ids = list.map((m) => m.id);
  return {
    ensure: async () => list.map((m) => ({ ...m })),
    list: () => list.map((m) => ({ ...m })),
    isKnownId: (id) => ids.includes(id),
    resolveModelId: (model) => {
      const id = typeof model === 'string' && model.startsWith('agy:') ? model.slice(4) : null;
      return id && ids.includes(id) ? id : null;
    },
  };
}

function setup({ packages, extraDeps = {}, prefModel = 'opus' } = {}) {
  const log = { sessions: [], saved: [], planner: [], lines: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [
      { at: 1, text: 'one', done: false },
      { at: 2, text: 'two', done: false },
      { at: 3, text: 'three', done: false },
    ],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async (args) => {
      log.planner.push(args);
      return { ok: true, raw: { packages: packages || [pkg('a', 'sonnet'), pkg('b', 'opus', { at: 2 })], notes: '' }, costUsd: 0 };
    },
    addWorktree: async (repo, name) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `luna/${name}` }),
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
    workerSettings: () => ({ model: prefModel, effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }),
    saveWorkerModel: (model) => log.saved.push(model),
    log: (line) => log.lines.push(line),
    setTimer: () => ({}),
    clearTimer: () => {},
    ...extraDeps,
  });
  return { orch, log };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };
const approve = (plan, extra = {}) => ({ planId: plan.id, ids: null, prompts: {}, integration: 'branches', ...extra });
/** The worker tab a package opened: it runs on the package's branch. */
const sessionFor = (log, plan, id) => {
  const view = plan.packages.find((p) => p.id === id);
  return log.sessions.find((s) => view && view.branch && s.branch === view.branch) || null;
};

// ---- Rule 2: today's Opus run, byte for byte -------------------------------------

test('regression: the planner prompt, schema and args equal the v0.33.0 baseline (no pool / one-model pool)', () => {
  assert.equal(planner.buildPlannerPrompt(BASELINE.todos), BASELINE.prompt);
  assert.equal(planner.buildPlannerPrompt(BASELINE.todos, { pool: ['opus'] }), BASELINE.prompt);
  assert.equal(JSON.stringify(planner.planSchemaFor(false, false)), BASELINE.schema);
  assert.equal(JSON.stringify(planner.planSchemaFor(false, false, ['opus'])), BASELINE.schema);
  assert.deepEqual(planner.buildPlannerArgs({}), BASELINE.args);
  assert.deepEqual(planner.buildPlannerArgs({ pool: ['opus'] }), BASELINE.args);
  assert.deepEqual(planner.buildPlannerArgs({ model: 'opus', effort: 'high' }), BASELINE.argsHigh);
});

test('regression: runPlan with Workers [Opus] calls makePlan exactly as without a pool', async () => {
  const calls = [];
  const runCtx = {
    registry: { ensure: () => ({ makePlan: async (args) => { calls.push(args); return { ok: false, error: 'stop' }; } }) },
    toolEnv: () => ({ ENV: 1 }),
    send: () => {},
  };
  const session = { projectId: 'p1', profileId: 'claude-cloud' };
  const target = { projectId: 'p1', repoPath: '/repo' };
  await runPlan(runCtx, session, target, { picked: null, effort: 'high', planner: 'claude', workers: 'claude', model: 'opus', followups: false });
  await runPlan(runCtx, session, target, { picked: null, effort: 'high', planner: 'claude', workers: 'claude', model: 'opus', followups: false, modelPool: OPUS_ONLY });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal('modelPool' in calls[0], false);
});

test('regression: makePlan + Approve on Opus - same planner call, same plan, every package on Opus, same pref', async () => {
  const plain = setup();
  const pooled = setup();
  const a = await plain.orch.makePlan(ctx);
  const b = await pooled.orch.makePlan({ ...ctx, modelPool: OPUS_ONLY });
  assert.deepEqual(pooled.log.planner, plain.log.planner);
  assert.deepEqual({ ...b.plan, id: null }, { ...a.plan, id: null });
  assert.equal('modelPool' in a.plan, false);
  // Approve sends what the HUD sends for Workers [Opus]: {workerModel: 'opus'}.
  const ra = await plain.orch.launch(approve(a.plan, { workers: 'claude', workerModel: 'opus' }));
  const rb = await pooled.orch.launch(approve(b.plan, { workers: 'claude', workerModel: 'opus' }));
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  for (const r of [ra, rb]) {
    assert.equal(r.plan.workerModel, 'opus');
    assert.equal(r.plan.workers, 'claude');
    assert.equal('modelPool' in r.plan, false);
  }
  const strip = (s) => ({ profileId: s.profileId, model: s.task.model, effort: s.task.effort, permissionMode: s.task.permissionMode });
  assert.deepEqual(pooled.log.sessions.map(strip), plain.log.sessions.map(strip));
  assert.deepEqual(plain.log.sessions.map((s) => s.task.model), ['opus', 'opus']);
  assert.deepEqual(plain.log.sessions.map((s) => s.profileId), ['claude-cloud', 'claude-cloud']);
  assert.deepEqual(pooled.log.saved, plain.log.saved);
});

// ---- the planner is offered only the ticked models -------------------------------

test('a pool of 2+ models: the planner gets exactly its keys (prompt rules + schema enum)', async () => {
  const { orch, log } = setup();
  await orch.makePlan({ ...ctx, modelPool: [e('sonnet'), e('opus')] });
  assert.deepEqual(log.planner[0].pool, ['opus', 'sonnet']);
  const args = planner.buildPlannerArgs({ pool: log.planner[0].pool });
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  const items = schema.properties.packages.items;
  assert.deepEqual(items.properties.model.enum, ['opus', 'sonnet']);
  assert.ok(items.required.includes('modelReason'));
  const prompt = planner.buildPlannerPrompt([{ at: 1, text: 'x' }], { pool: ['opus', 'sonnet'] });
  assert.match(prompt, /exactly these models - plan the WHOLE run for them and never name another: "opus" \(Claude Opus\), "sonnet" \(Claude Sonnet\)\./);
  assert.match(prompt, /Easy work .* goes to "sonnet"\./);
  assert.match(prompt, /Hard work .* goes to "opus"\./);
  assert.match(prompt, /If unsure, use "opus"\./);
  assert.doesNotMatch(prompt, /agy|free|"model": "opus" for hard/);
});

test('validatePlan: an out-of-pool pick goes to the strongest ticked model, warned and logged', async () => {
  const todos = [{ at: 1, text: 'one' }, { at: 2, text: 'two' }];
  const res = planner.validatePlan({ packages: [pkg('a', 'fable'), pkg('b', 'sonnet', { at: 2 })], notes: '' }, todos, { pool: ['sonnet', 'agy-argon'] });
  assert.deepEqual(res.packages.map((p) => [p.id, p.model, p.poolModel, p.poolFrom]), [['a', 'agy-argon', 'agy-argon', 'fable'], ['b', 'sonnet', 'sonnet', undefined]]);
  assert.deepEqual(res.warnings.filter((w) => w.code === 'outOfPool'), [{ code: 'outOfPool', id: 'a', from: 'fable', to: 'agy-argon' }]);
  // Through makePlan the move is logged too, and the plan keeps the pool and the reasons.
  const { orch, log } = setup({ packages: [pkg('a', 'fable'), pkg('b', 'sonnet', { at: 2 })] });
  const made = await orch.makePlan({ ...ctx, modelPool: [e('sonnet'), e('opus')] });
  assert.equal(made.plan.packages.find((p) => p.id === 'a').model, 'opus');
  assert.ok(log.lines.some((l) => /package a: fable is not in the Workers pool, runs on opus/.test(l)));
  assert.deepEqual(made.plan.modelPool, [e('sonnet'), e('opus')]);
  assert.equal(made.plan.packages.find((p) => p.id === 'b').modelReason, 'b reason');
});

test('an agy family the live list lacks is never offered; fewer than two left plans as before', async () => {
  const some = setup({ extraDeps: { agyModels: fakeAgyModels(LIVE.filter((m) => !m.id.includes('hydrogen'))) } });
  await some.orch.makePlan({ ...ctx, modelPool: [e('opus'), e('agy-argon'), e('agy-hydrogen')] });
  assert.deepEqual(some.log.planner[0].pool, ['opus', 'agy-argon']);
  assert.ok(some.log.lines.some((l) => /agy-hydrogen is not in the live/.test(l)));
  // No agy list at all: Argon cannot run, one model is left, the plan is today's.
  const none = setup();
  const made = await none.orch.makePlan({ ...ctx, modelPool: [e('sonnet'), e('agy-argon')] });
  assert.equal(none.log.planner[0].pool, undefined);
  assert.equal('modelPool' in made.plan, false);
});

// ---- a mixed run: every package runs on its pick ---------------------------------

const MIXED = [e('opus'), e('agy-argon'), e('free:freellm-chain')];
const mixedPackages = () => [pkg('a', 'agy-argon'), pkg('b', 'opus', { at: 2 }), pkg('c', 'free', { at: 3 })];
const mixedDeps = () => ({
  agyModels: fakeAgyModels(),
  agyProfileId: () => 'agy-profile',
  codingProfileId: (preferred) => preferred || 'default-coding',
});

test('mixed run: agy on the agy profile with its --model, free on the ticked coding profile, Claude on Claude', async () => {
  const { orch, log } = setup({ packages: mixedPackages(), extraDeps: mixedDeps() });
  const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
  assert.equal(made.plan.workers, 'hybrid');
  assert.deepEqual(made.plan.packages.map((p) => p.model), ['agy:gemini-4-argon-medium', 'opus', 'free']);
  assert.equal(made.plan.workerModel, 'plan', "a pool plan reads Planner's pick before Approve");
  const res = await orch.launch(approve(made.plan, { workers: 'hybrid', modelPool: MIXED }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.plan.workerModel, 'plan');
  assert.deepEqual(res.plan.modelPool, MIXED);
  const route = Object.fromEntries(res.plan.packages.map((p) => [p.id, sessionFor(log, res.plan, p.id)]));
  assert.equal(route.a.profileId, 'agy-profile');
  assert.equal(route.a.task.model, 'agy:gemini-4-argon-medium');
  assert.equal(route.b.profileId, 'claude-cloud');
  assert.equal(route.b.task.model, 'opus');
  assert.equal(route.c.profileId, 'freellm-chain');
  // A pool run saves no single-model pref.
  assert.deepEqual(log.saved, []);
});

test('mixed run without an agy profile is refused, never run on Claude', async () => {
  const { orch, log } = setup({ packages: mixedPackages(), extraDeps: { ...mixedDeps(), agyProfileId: () => null } });
  const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
  const res = await orch.launch(approve(made.plan, { workers: 'hybrid', modelPool: MIXED }));
  assert.deepEqual(res, { ok: false, error: 'noAgyProfile' });
  assert.equal(log.sessions.length, 0);
});

test('Approve re-picks the pool: an unticked model moves to the strongest ticked one', async () => {
  const { orch, log } = setup({ packages: mixedPackages(), extraDeps: mixedDeps() });
  const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
  const res = await orch.launch(approve(made.plan, { workers: 'hybrid', modelPool: [e('sonnet'), e('agy-hydrogen')] }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.plan.packages.map((p) => p.model), ['sonnet', 'sonnet', 'sonnet']);
  assert.deepEqual(res.plan.packages.map((p) => p.poolFrom), ['agy-argon', 'opus', 'free']);
  assert.ok(log.lines.some((l) => /package a: agy-argon is not in the Workers pool, runs on sonnet/.test(l)));
});

test("the phone: no pool and no model (or the view's 'plan') keeps the plan's own pool; a named model is a single run", async () => {
  for (const extra of [{}, { workerModel: 'plan' }]) {
    const { orch } = setup({ packages: mixedPackages(), extraDeps: mixedDeps() });
    const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
    const res = await orch.launch(approve(made.plan, extra));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.plan.modelPool, MIXED);
    assert.equal(res.plan.workerModel, 'plan');
  }
  const { orch, log } = setup({ extraDeps: mixedDeps() });
  const made = await orch.makePlan({ ...ctx, modelPool: [e('opus'), e('sonnet')] });
  const res = await orch.launch(approve(made.plan, { workerModel: 'fable' }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, 'fable');
  assert.equal('modelPool' in res.plan, false);
  assert.deepEqual(log.sessions.map((s) => s.task.model), ['fable', 'fable']);
});

test("one-model pools at Approve map onto today's values", async () => {
  const agy = setup({ extraDeps: mixedDeps() });
  const a = await agy.orch.makePlan(ctx);
  const ra = await agy.orch.launch(approve(a.plan, { modelPool: [e('agy-argon')] }));
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(ra.plan.workerModel, 'agy:gemini-4-argon-high');
  assert.deepEqual(agy.log.sessions.map((s) => s.profileId), ['agy-profile', 'agy-profile']);
  assert.deepEqual(agy.log.saved, ['agy:gemini-4-argon-high']);
  const sonnet = setup();
  const s = await sonnet.orch.makePlan(ctx);
  const rs = await sonnet.orch.launch(approve(s.plan, { modelPool: [e('sonnet')] }));
  assert.equal(rs.plan.workerModel, 'sonnet');
  assert.deepEqual(sonnet.log.sessions.map((x) => x.task.model), ['sonnet', 'sonnet']);
});

test('a restart keeps a pool run on its picks: pool, package fields and both worker profiles round-trip', async () => {
  let saved = null;
  const { orch } = setup({ packages: mixedPackages(), extraDeps: { ...mixedDeps(), saveState: (data) => (saved = data) } });
  const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
  const res = await orch.launch(approve(made.plan, { workers: 'hybrid', modelPool: MIXED }));
  assert.equal(res.ok, true, JSON.stringify(res));
  const back = sup.normalizeStoredPlan(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(back.modelPool, MIXED);
  assert.equal(back.workerModel, 'plan');
  assert.equal(back.hybridProfileId, 'freellm-chain');
  // Without it a resumed agy package would reopen on the Claude profile.
  assert.equal(back.agyProfileId, 'agy-profile');
  const a = back.packages.find((p) => p.id === 'a');
  assert.deepEqual([a.model, a.poolModel, a.modelReason], ['agy:gemini-4-argon-medium', 'agy-argon', 'a reason']);
});

test('a refused Approve changes no package: the retry still sees the planner\'s picks', async () => {
  const { orch, log } = setup({ extraDeps: { ...mixedDeps(), agyProfileId: () => null } });
  const made = await orch.makePlan({ ...ctx, modelPool: [e('opus'), e('sonnet')] });
  const before = made.plan.packages.map((p) => [p.model, p.poolModel, p.poolFrom || null]);
  // Both packages would move to Argon, which needs an agy profile: refused, and nothing moved meanwhile.
  const refused = await orch.launch(approve(made.plan, { modelPool: [e('agy-argon'), e('agy-hydrogen')] }));
  assert.deepEqual(refused, { ok: false, error: 'noAgyProfile' });
  assert.deepEqual(orch.view().packages.map((p) => [p.model, p.poolModel, p.poolFrom || null]), before);
  const res = await orch.launch(approve(made.plan, { modelPool: [e('opus'), e('sonnet')] }));
  assert.equal(res.ok, true);
  assert.deepEqual(log.sessions.map((s) => s.task.model), ['sonnet', 'opus']);
});

test('a plan discarded while Approve reads `agy models` is not launched', async () => {
  const agy = fakeAgyModels();
  const { orch, log } = setup({ packages: mixedPackages(), extraDeps: { ...mixedDeps(), agyModels: agy } });
  const made = await orch.makePlan({ ...ctx, modelPool: MIXED });
  // Approve's read of the list hangs until released; the plan is discarded meanwhile.
  let release = null;
  agy.ensure = () => new Promise((r) => (release = () => r(LIVE)));
  const launching = orch.launch(approve(made.plan, { workers: 'hybrid', modelPool: MIXED }));
  const discarded = await orch.discard();
  assert.equal(discarded && discarded.ok, true, JSON.stringify(discarded));
  release();
  assert.deepEqual(await launching, { ok: false, error: 'busy' });
  assert.equal(log.sessions.length, 0);
});

// ---- the agy planner's model -------------------------------------------------------

test('agy planner: runPlan forwards an agy family, never a Claude alias', async () => {
  const calls = [];
  const runCtx = {
    registry: { ensure: () => ({ makePlan: async (args) => { calls.push(args); return { ok: false, error: 'stop' }; } }) },
    toolEnv: () => ({}),
    agyPlannerEnv: () => ({ AGY: 1 }),
    send: () => {},
  };
  const session = { projectId: 'p1', profileId: 'claude-cloud' };
  const target = { projectId: 'p1', repoPath: '/repo' };
  const plan = (model) => runPlan(runCtx, session, target, { picked: null, effort: 'high', planner: 'agy', workers: 'claude', model, followups: false });
  await plan('agy-argon');
  await plan('opus');
  await plan('agy:gemini-4-argon-high');
  assert.equal(calls[0].plannerAgyModel, 'agy-argon');
  assert.equal(calls[0].planner, 'agy');
  assert.equal('plannerAgyModel' in calls[1], false);
  assert.equal('plannerAgyModel' in calls[2], false);
});

test('agy planner: makePlan resolves the family to the live variant nearest the planner effort', async () => {
  const { orch, log } = setup({ extraDeps: { agyModels: fakeAgyModels() } });
  await orch.makePlan({ ...ctx, planner: 'agy', plannerAgyModel: 'agy-argon', plannerEffort: 'medium' });
  assert.equal(log.planner[0].agyModel, 'gemini-4-argon-medium');
  assert.equal(log.planner[0].planner, 'agy');
  // A family the live list lacks: agy's default model, logged.
  const missing = setup({ extraDeps: { agyModels: fakeAgyModels(LIVE.filter((m) => !m.id.includes('hydrogen'))) } });
  await missing.orch.makePlan({ ...ctx, planner: 'agy', plannerAgyModel: 'agy-hydrogen' });
  assert.equal('agyModel' in missing.log.planner[0], false);
  assert.ok(missing.log.lines.some((l) => /agy planner model agy-hydrogen is not in the live/.test(l)));
  // The Claude planner never gets an agy model.
  const claude = setup({ extraDeps: { agyModels: fakeAgyModels() } });
  await claude.orch.makePlan({ ...ctx, plannerAgyModel: 'agy-argon' });
  assert.equal('agyModel' in claude.log.planner[0], false);
});

test('agy planner: runPlanner hands agy the --model id; none = no flag', async () => {
  const argvs = [];
  const execImpl = (bin, args, opts, cb) => {
    argvs.push([bin, ...args]);
    setImmediate(() => cb(null, JSON.stringify({ packages: [], notes: '' }), ''));
    return { stdin: { on: () => {}, end: () => {} } };
  };
  const base = { cwd: __dirname, env: {}, openTodos: [{ at: 1, text: 'x' }], planner: 'agy', execImpl };
  await planner.runPlanner({ ...base, agyModel: 'gemini-4-argon-high' });
  await planner.runPlanner(base);
  assert.deepEqual(argvs[0].slice(-2), ['--model', 'gemini-4-argon-high']);
  assert.equal(argvs[1].includes('--model'), false);
});

test('agy planner pref: an agy family or null', () => {
  const { agyPlannerModelOf } = require('../src/uiprefs');
  assert.equal(agyPlannerModelOf('agy-hydrogen'), 'agy-hydrogen');
  for (const bad of ['opus', 'agy', 'agy:gemini-4-argon-high', null, 7]) assert.equal(agyPlannerModelOf(bad), null);
});

test('Approve refuses an off-shape pool', async () => {
  const { orch, log } = setup();
  const made = await orch.makePlan(ctx);
  assert.deepEqual(await orch.launch(approve(made.plan, { modelPool: 'opus,sonnet' })), { ok: false, error: 'badModelPool' });
  assert.equal(log.sessions.length, 0);
});
