// ============================================================================
// God Mode v2 planner model, picked next to the effort in the to-do picker:
// the allow-list, the planner argv (default = byte-identical to before), the
// model carried through makePlan's ctx (limit-wait and account-failover
// replans), runPlan's validation, the board view, the stored plan, the ui pref
// and Luna's Work passing its builder model. Mirrors planner-effort.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PLANNER_MODEL, PLANNER_MODELS, plannerModelOf, buildPlannerArgs, runPlanner } = require('../src/orchestraPlan.js');
const { createOrchestra } = require('../src/orchestra.js');
const { runPlan } = require('../src/orchestraPlanStart.js');
const sup = require('../src/orchestraSupervisor.js');
const paths = require('../src/paths.js');
const uiprefs = require('../src/uiprefs.js');
const { createGodModeBuilder, plannerModelFor } = require('../src/lunasworkBuild.js');

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];
const MIN = 60 * 1000;
const BAD_MODELS = ['', 'OPUS', 'gpt-5', 'opus; rm -rf /', '--dangerously-skip-permissions', null, undefined, 3, { model: 'fable' }, ['fable']];

// ---- allow-list / argv ------------------------------------------------------------

test('plannerModelOf: the four aliases pass, anything else is opus', () => {
  assert.equal(PLANNER_MODEL, 'opus');
  assert.deepEqual([...PLANNER_MODELS], ['haiku', 'sonnet', 'opus', 'fable']);
  for (const model of PLANNER_MODELS) assert.equal(plannerModelOf(model), model);
  for (const bad of BAD_MODELS) assert.equal(plannerModelOf(bad), 'opus');
});

test('buildPlannerArgs: --model follows the choice; no choice or a bad one is the old argv', () => {
  const before = buildPlannerArgs();
  assert.equal(flagValue(before, '--model'), 'opus');
  for (const model of PLANNER_MODELS) assert.equal(flagValue(buildPlannerArgs({ model }), '--model'), model);
  assert.deepEqual(buildPlannerArgs({ model: 'opus' }), before);
  for (const bad of BAD_MODELS) assert.deepEqual(buildPlannerArgs({ model: bad }), before, `rejects ${String(bad)}`);
  // Only the --model value differs for another alias.
  const fable = buildPlannerArgs({ model: 'fable' });
  assert.deepEqual(fable.map((a, i) => (i === fable.indexOf('--model') + 1 ? 'opus' : a)), before);
  // The free planner keeps its own model whatever is asked.
  assert.deepEqual(buildPlannerArgs({ planner: 'free', model: 'fable' }), buildPlannerArgs({ planner: 'free' }));
});

function fakeExec() {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(null, JSON.stringify({ structured_output: { packages: [] }, total_cost_usd: 0 })));
    return { stdin: { on() {}, end() {} } };
  };
  return { exec, calls };
}

test('runPlanner: the chosen model reaches `claude -p --model`; bad or missing = opus', async () => {
  const run = async (extra) => {
    const { exec, calls } = fakeExec();
    await runPlanner({ isDirImpl: () => true, cwd: 'C:/repo', env: {}, openTodos: [], execImpl: exec, ...extra });
    return calls[0];
  };
  for (const model of PLANNER_MODELS) {
    const call = await run({ model });
    assert.equal(call.file, 'claude');
    assert.equal(call.args[0], '-p');
    assert.equal(flagValue(call.args, '--model'), model);
  }
  const plain = await run({});
  assert.equal(flagValue(plain.args, '--model'), 'opus');
  for (const bad of BAD_MODELS) assert.deepEqual((await run({ model: bad })).args, plain.args);
});

// ---- makePlan: ctx -> runPlanner, replans, view --------------------------------------

const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const spentLimits = [
  { window: '5h', percentUsed: 100, resetsAt: iso(NOW + 30 * MIN) },
  { window: 'weekly', percentUsed: 30, resetsAt: iso(NOW + 3 * 86400e3) },
];
const goodPlan = () => ({
  ok: true,
  raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' }], notes: '' },
  costUsd: 0.1,
});

function fakeClock() {
  let t = NOW;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: t + ms });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        await due[1].fn();
        for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
      }
      t = end;
    },
  };
}

function orchestraWith(results, extra = {}) {
  const clock = fakeClock();
  const calls = [];
  const orch = createOrchestra({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async (args) => {
      calls.push(args);
      return results.shift();
    },
    addWorktree: async () => ({ ok: false }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    ...extra,
  });
  // What the real runPlanner would put after --model for these args.
  const models = () => calls.map((a) => plannerModelOf(a.model));
  return { orch, clock, calls, models };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test('makePlan hands ctx.plannerModel to the planner and shows it on the plan', async () => {
  const { orch, calls, models } = orchestraWith([goodPlan()]);
  const res = await orch.makePlan({ ...ctx, plannerModel: 'fable' });
  assert.equal(res.ok, true);
  assert.equal(calls[0].model, 'fable');
  assert.deepEqual(models(), ['fable']);
  assert.equal(orch.view().model, 'fable');
});

test('makePlan without plannerModel, with opus or with a bad one: the planner args are the old ones', async () => {
  for (const plannerModel of [undefined, 'opus', 'gpt-5', 'fable --dangerously-skip-permissions', 7]) {
    const { orch, calls } = orchestraWith([goodPlan()]);
    await orch.makePlan(plannerModel === undefined ? ctx : { ...ctx, plannerModel });
    assert.equal('model' in calls[0], false, `no model key for ${String(plannerModel)}`);
    assert.deepEqual(Object.keys(calls[0]), ['cwd', 'env', 'openTodos', 'effort']);
    assert.equal(orch.view().model, 'opus');
  }
});

test('a usage-limit replan keeps the chosen model', async () => {
  const { orch, clock, models } = orchestraWith([{ ok: false, error: 'limit' }, goodPlan()], { usageLimits: () => spentLimits });
  const res = await orch.makePlan({ ...ctx, plannerModel: 'haiku' });
  assert.equal(res.error, 'waiting');
  await clock.advance(2 * 3600e3);
  assert.deepEqual(models(), ['haiku', 'haiku']);
  assert.equal(orch.view().model, 'haiku');
});

test('an account-failover replan keeps the chosen model with a fresh env', async () => {
  const { orch, clock, calls, models } = orchestraWith([{ ok: false, error: 'limit' }, goodPlan()], {
    usageLimits: () => spentLimits,
    accountFailover: () => true,
    freshEnv: () => ({ ACCOUNT: 'b' }),
  });
  const res = await orch.makePlan({ ...ctx, plannerModel: 'fable' });
  assert.equal(res.error, 'waiting');
  assert.equal(res.planWait.source, 'account');
  await clock.advance(MIN);
  assert.deepEqual(models(), ['fable', 'fable']);
  assert.deepEqual(calls[1].env, { ACCOUNT: 'b' });
  assert.equal(orch.view().model, 'fable');
});

test('the free planner never gets the Claude planner model', async () => {
  const { orch, calls } = orchestraWith([goodPlan()]);
  await orch.makePlan({ ...ctx, planner: 'free', plannerModel: 'fable' });
  assert.equal('model' in calls[0], false);
});

// ---- runPlan (orchestra:plan and the phone share it) ----------------------------------

function planCtx() {
  const made = [];
  return {
    made,
    ctx: {
      registry: { ensure: () => ({ makePlan: async (c) => (made.push(c), { ok: false, error: 'x' }) }) },
      toolEnv: () => ({ PATH: 'x' }),
      freePlannerEnv: () => ({ FREE: '1' }),
      send: () => {},
    },
  };
}
const session = { projectId: 'p1', profileId: 'claude' };
const target = { projectId: 'p1', repoPath: '/repo' };

test('runPlan validates the model in main: an alias passes, anything else adds no key', async () => {
  for (const model of ['haiku', 'sonnet', 'fable']) {
    const { ctx: c, made } = planCtx();
    await runPlan(c, session, target, { picked: null, model });
    assert.equal(made[0].plannerModel, model);
  }
  for (const bad of ['opus', ...BAD_MODELS]) {
    const { ctx: c, made } = planCtx();
    await runPlan(c, session, target, { picked: null, model: bad });
    assert.equal('plannerModel' in made[0], false, `no key for ${String(bad)}`);
  }
  const { ctx: c, made } = planCtx();
  await runPlan(c, session, target, { picked: null, planner: 'free', model: 'fable' });
  assert.equal('plannerModel' in made[0], false, 'the free planner has its own model');
});

// ---- stored plan / ui pref --------------------------------------------------------------

test('a stored plan keeps a valid non-default plannerModel, anything else carries no key', () => {
  const raw = { id: 'p1', repoPath: path.resolve('/repo'), packages: [{ id: 'a', state: 'pending' }] };
  assert.equal(sup.normalizeStoredPlan({ ...raw, plannerModel: 'fable' }).plannerModel, 'fable');
  for (const bad of ['opus', 'gpt-5', 7, null]) {
    assert.equal('plannerModel' in sup.normalizeStoredPlan({ ...raw, plannerModel: bad }), false);
  }
  assert.equal('plannerModel' in sup.normalizeStoredPlan(raw), false);
});

test('ui pref orchestraPlannerModel: default opus, only the aliases are stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-planner-model-'));
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(() => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  assert.equal(uiprefs.readUiPrefs().orchestraPlannerModel, 'opus', 'missing file -> default');
  assert.equal(uiprefs.writeUiPrefs({ orchestraPlannerModel: 'fable' }).orchestraPlannerModel, 'fable');
  assert.equal(uiprefs.readUiPrefs().orchestraPlannerModel, 'fable');
  for (const bad of ['plan', 'auto', 'FABLE', '', null, 7]) {
    assert.equal(uiprefs.writeUiPrefs({ orchestraPlannerModel: bad }).orchestraPlannerModel, 'fable', `rejects ${String(bad)}`);
  }
  const file = path.join(dir, 'ui.local.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, orchestraPlannerModel: 'gpt-5' }), 'utf8');
  assert.equal(uiprefs.readUiPrefs().orchestraPlannerModel, 'opus');
});

// ---- Luna's Work: the build's planner runs on the run's builder model --------------------

const tick = () => new Promise((r) => setImmediate(r));

async function lwPlanCtx(cards, opts = {}) {
  const made = [];
  const orchestra = {
    makePlan: async (c) => (made.push(c), { ok: false, error: 'failed' }),
    launch: async () => ({ ok: true }),
    cancelPlanWait: () => {},
  };
  const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({ PAID: '1' }), freeEnv: () => ({ FREE: '1' }) });
  await builder.build({ projectId: 'game', repoPath: '/repo', cards, checkCommand: '', ...opts });
  await tick();
  return made[0];
}

test("a Luna's Work build passes its cards' model to God Mode's planner", async () => {
  const card = (at, model) => ({ at, text: `card ${at}`, model });
  assert.equal(plannerModelFor([card(1, 'haiku'), card(2, 'haiku')]), 'haiku');
  assert.equal(plannerModelFor([card(1, 'sonnet'), card(2, 'opus')]), 'opus');
  assert.equal(plannerModelFor([card(1, 'opus'), card(2, 'fable')]), 'fable');
  assert.equal(plannerModelFor([card(1, 'gpt-5'), card(2, undefined)]), null);

  // A run whose builder is set to Haiku does not plan on Opus.
  assert.equal((await lwPlanCtx([card(1, 'haiku'), card(2, 'haiku')])).plannerModel, 'haiku');
  assert.equal((await lwPlanCtx([card(1, 'fable')])).plannerModel, 'fable');
  assert.equal((await lwPlanCtx([card(1, 'sonnet'), card(2, 'opus')])).plannerModel, 'opus');
  // An explicit model from the controller wins; an unknown one falls back to the cards.
  assert.equal((await lwPlanCtx([card(1, 'opus')], { plannerModel: 'sonnet' })).plannerModel, 'sonnet');
  assert.equal((await lwPlanCtx([card(1, 'haiku')], { plannerModel: 'gpt-5' })).plannerModel, 'haiku');
  // No known card model, or a free build: no key - God Mode plans as before.
  assert.equal('plannerModel' in (await lwPlanCtx([card(1, 'gpt-5')])), false);
  assert.equal('plannerModel' in (await lwPlanCtx([card(1, 'haiku')], { free: true })), false);
});

test("end to end: a Haiku Luna's Work build reaches the planner's --model through makePlan", async () => {
  const { orch, models } = orchestraWith([goodPlan()]);
  const builder = createGodModeBuilder({
    orchestra: { makePlan: (c) => orch.makePlan(c), launch: async () => ({ ok: false, error: 'stop' }), cancelPlanWait: () => {} },
    profileId: () => 'default',
    env: () => ({}),
  });
  await builder.build({ projectId: 'p1', repoPath: '/repo', cards: [{ at: 1, text: 'one', model: 'haiku' }], checkCommand: '' });
  assert.deepEqual(models(), ['haiku']);
});
