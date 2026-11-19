// God Mode "Workers model" on the Approve screen and the phone: launch()
// takes an allow-listed workerModel before the run starts (freezes it, saves
// the pref), ignores anything else, never changes a started run; each
// package's badge mirrors the model it will run on (src/orchestraWorkerModel.js
// packageModelOf and its renderer twin); the allow-lists and pl/en strings
// stay in line.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createOrchestra } = require('../src/orchestra');
const main = require('../src/orchestraWorkerModel');
const { ORCHESTRA_WORKER_MODELS } = require('../src/uiprefs');
const { PLAN_WORKER_MODELS } = require('../src/godmodesnapshot');
const rules = require('../src/renderer/modules/orchestraWorkerModelRules.js');
const phone = require('../mobile/src/godmodeplanmodel.js');

const ROOT = path.join(__dirname, '..');
const base = { todoAts: [1], dependsOn: [], verify: 'npm test', files: ['src/a.js'] };
const PACKAGES = [
  { ...base, id: 'a', title: 'A', prompt: 'do a', model: 'sonnet' },
  { ...base, id: 'b', title: 'B', prompt: 'do b', model: 'opus', todoAts: [2] },
];

function setup({ packages = PACKAGES, prefModel = 'opus', extraDeps = {} } = {}) {
  const log = { sessions: [], saved: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [
      { at: 1, text: 'one', done: false },
      { at: 2, text: 'two', done: false },
    ],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
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
    // No real timers: a scheduled start or a nudge must not keep the test process alive.
    setTimer: () => ({}),
    clearTimer: () => {},
    ...extraDeps,
  });
  return { orch, log };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };
const approve = (plan, extra = {}) => ({ planId: plan.id, ids: null, prompts: {}, integration: 'branches', ...extra });
const models = (log) => log.sessions.map((s) => s.task.model);

// ---- launch: validation + freeze --------------------------------------------

test('Approve with workerModel: the run freezes it, every worker uses it, the pref is saved', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'fable' }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, 'fable');
  assert.deepEqual(models(log), ['fable', 'fable']);
  assert.deepEqual(log.saved, ['fable']);
});

test('Approve with workerModel "plan": each package on its planner pick', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'plan' }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, 'plan');
  assert.deepEqual(models(log), ['sonnet', 'opus']);
});

test('Approve with workerModel "plan": an agy pick runs on the agy profile with its --model, the rest on Claude', async () => {
  const packages = [
    { ...PACKAGES[0], model: 'agy:gemini-4-argon-medium' },
    PACKAGES[1],
  ];
  const agyModels = fakeAgyModels(['gemini-4-argon-medium']);
  const { orch, log } = setup({ packages, extraDeps: { agyProfileId: () => 'agy-profile', agyModels } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'plan' }));
  assert.equal(res.ok, true);
  assert.deepEqual(models(log), ['agy:gemini-4-argon-medium', 'opus']);
  assert.deepEqual(log.sessions.map((s) => s.profileId), ['agy-profile', 'claude-cloud']);
});

test('Approve with workerModel "plan": an agy pick without an agy profile is refused, never run on Claude', async () => {
  const packages = [{ ...PACKAGES[0], model: 'agy' }, PACKAGES[1]];
  const { orch, log } = setup({ packages, extraDeps: { agyProfileId: () => null } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'plan' }));
  assert.deepEqual(res, { ok: false, error: 'noAgyProfile' });
  assert.equal(log.sessions.length, 0);
});

test('Approve with workerModel "agy": the run freezes it, the pref is saved, tabs open on the agy profile', async () => {
  const { orch, log } = setup({ extraDeps: { agyProfileId: () => 'agy-profile' } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'agy' }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, 'agy');
  assert.deepEqual(models(log), ['agy', 'agy']);
  assert.deepEqual(log.saved, ['agy']);
  assert.deepEqual(log.sessions.map((s) => s.profileId), ['agy-profile', 'agy-profile']);
});

test('Approve with workerModel "agy" and no agy profile: a clear refusal, nothing launched or saved', async () => {
  const { orch, log } = setup({ extraDeps: { agyProfileId: () => null } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'agy' }));
  assert.deepEqual(res, { ok: false, error: 'noAgyProfile' });
  assert.equal(log.sessions.length, 0);
  assert.deepEqual(log.saved, []);
});

// ---- agy:<id> variants: checked against the live `agy models` list -------------

const ARGON = 'agy:gemini-4-argon-medium';

/** A fake src/agymodels.js cache holding `ids`. */
function fakeAgyModels(ids) {
  const seen = { ensured: 0 };
  return {
    seen,
    ensure: async () => {
      seen.ensured += 1;
      return ids.map((id) => ({ id, name: id }));
    },
    isKnownId: (id) => ids.includes(id),
    resolveModelId: (model) => {
      const id = typeof model === 'string' && model.startsWith('agy:') ? model.slice(4) : null;
      return id && ids.includes(id) ? id : null;
    },
  };
}

test('Approve with an agy:<id> worker model on the live list: frozen, saved, every tab on agy with that model', async () => {
  const agyModels = fakeAgyModels(['gemini-4-argon-medium']);
  const { orch, log } = setup({ extraDeps: { agyProfileId: () => 'agy-profile', agyModels } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: ARGON }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, ARGON);
  assert.deepEqual(models(log), [ARGON, ARGON]);
  assert.deepEqual(log.saved, [ARGON]);
  assert.deepEqual(log.sessions.map((s) => s.profileId), ['agy-profile', 'agy-profile']);
  assert.ok(agyModels.seen.ensured >= 1, 'the list was read before the check');
});

test('Approve with an agy:<id> the live list does not hold: badAgyModel, nothing launched or saved', async () => {
  for (const agyModels of [fakeAgyModels(['gemini-3.8-flash-low']), fakeAgyModels([]), undefined]) {
    const { orch, log } = setup({ extraDeps: { agyProfileId: () => 'agy-profile', ...(agyModels ? { agyModels } : {}) } });
    const { plan } = await orch.makePlan(ctx);
    const res = await orch.launch(approve(plan, { workerModel: ARGON }));
    assert.deepEqual(res, { ok: false, error: 'badAgyModel' });
    assert.equal(log.sessions.length, 0);
    assert.deepEqual(log.saved, []);
  }
});

test('Approve: a malformed agy variant is ignored like any unknown model (the pref decides)', async () => {
  const { orch, log } = setup({ extraDeps: { agyProfileId: () => 'agy-profile', agyModels: fakeAgyModels([]) } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'agy:--print' }));
  assert.equal(res.ok, true);
  assert.deepEqual(models(log), ['opus', 'opus']);
  assert.deepEqual(log.saved, []);
});

test('hybrid per-package agy:<id> and a per-package agy override reach the worker task', async () => {
  const agyModels = fakeAgyModels(['gemini-3.8-flash-low']);
  const packages = [
    { ...PACKAGES[0], model: 'agy:gemini-3.8-flash-low' },
    { ...PACKAGES[1], model: 'opus' },
  ];
  const { orch, log } = setup({ packages, extraDeps: { agyProfileId: () => 'agy-profile', agyModels } });
  const { plan } = await orch.makePlan({ ...ctx, workers: 'hybrid' });
  const res = await orch.launch(approve(plan, { workers: 'hybrid', workerModel: 'opus' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(models(log), ['agy:gemini-3.8-flash-low', 'opus']);
  assert.deepEqual(log.sessions.map((s) => s.profileId), ['agy-profile', 'claude-cloud']);
});

test('hybrid: a planner agy:<id> pick the live list does not hold runs on plain agy instead of blocking Approve', async () => {
  const agyModels = fakeAgyModels(['gemini-4-argon-medium']);
  const packages = [
    { ...PACKAGES[0], model: 'agy:gemini-made-up' },
    { ...PACKAGES[1], model: 'opus' },
  ];
  const { orch, log } = setup({ packages, extraDeps: { agyProfileId: () => 'agy-profile', agyModels } });
  const { plan } = await orch.makePlan({ ...ctx, workers: 'hybrid' });
  const res = await orch.launch(approve(plan, { workers: 'hybrid', workerModel: 'opus' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(models(log), ['agy', 'opus']);
  assert.deepEqual(log.sessions.map((s) => s.profileId), ['agy-profile', 'claude-cloud']);
});

test('view: an agy package card names the model it runs on (the variant, else the transcript reading)', async () => {
  const agyModels = fakeAgyModels(['gemini-4-argon-medium']);
  const variant = setup({ extraDeps: { agyProfileId: () => 'agy-profile', agyModels, sessionAgyModel: () => 'Gemini 9 (should not win)' } });
  const { plan: p1 } = await variant.orch.makePlan(ctx);
  const r1 = await variant.orch.launch(approve(p1, { workerModel: ARGON }));
  assert.deepEqual(r1.plan.packages.map((p) => p.agyModel), ['gemini-4-argon-medium', 'gemini-4-argon-medium']);

  const plain = setup({ extraDeps: { agyProfileId: () => 'agy-profile', sessionAgyModel: (id) => `Gemini 4 Argon (${id})` } });
  const { plan: p2 } = await plain.orch.makePlan(ctx);
  const r2 = await plain.orch.launch(approve(p2, { workerModel: 'agy' }));
  assert.deepEqual(r2.plan.packages.map((p) => p.agyModel), ['Gemini 4 Argon (s1)', 'Gemini 4 Argon (s2)']);

  const claude = setup();
  const { plan: p3 } = await claude.orch.makePlan(ctx);
  const r3 = await claude.orch.launch(approve(p3, { workerModel: 'opus' }));
  assert.deepEqual(r3.plan.packages.map((p) => p.agyModel), [null, null]);
});

test('Approve with workers "agy": every tab on the agy profile; workers "claude" stays on the tab profile', async () => {
  const agy = setup({ extraDeps: { agyProfileId: () => 'agy-profile' } });
  const { plan } = await agy.orch.makePlan(ctx);
  const res = await agy.orch.launch(approve(plan, { workers: 'agy' }));
  assert.equal(res.ok, true);
  assert.deepEqual(agy.log.sessions.map((s) => s.profileId), ['agy-profile', 'agy-profile']);
  const claude = setup({ extraDeps: { agyProfileId: () => 'agy-profile' } });
  const second = await claude.orch.makePlan(ctx);
  assert.equal((await claude.orch.launch(approve(second.plan, { workers: 'claude' }))).ok, true);
  assert.deepEqual(claude.log.sessions.map((s) => s.profileId), ['claude-cloud', 'claude-cloud']);
});

for (const bad of ['agyy', 'AGY', 'gemini', 42, { w: 'agy' }]) {
  test(`Approve with an off-list workers value (${JSON.stringify(bad)}) is refused, never coerced to Claude`, async () => {
    const { orch, log } = setup({ extraDeps: { agyProfileId: () => 'agy-profile' } });
    const { plan } = await orch.makePlan(ctx);
    assert.deepEqual(await orch.launch(approve(plan, { workers: bad })), { ok: false, error: 'badWorkers' });
    assert.equal(log.sessions.length, 0);
  });
}

test('Approve with workers "agy" and no agy profile: refused with noAgyProfile', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  assert.deepEqual(await orch.launch(approve(plan, { workers: 'agy' })), { ok: false, error: 'noAgyProfile' });
  assert.equal(log.sessions.length, 0);
});

for (const bad of ['gpt-5', 'OPUS', 'AGY', 'antigravity', '', 42, { model: 'opus' }, ['sonnet'], true]) {
  test(`Approve with an invalid workerModel (${JSON.stringify(bad)}) is ignored: the pref decides`, async () => {
    const { orch, log } = setup({ prefModel: 'sonnet' });
    const { plan } = await orch.makePlan(ctx);
    const res = await orch.launch(approve(plan, { workerModel: bad }));
    assert.equal(res.ok, true);
    assert.equal(res.plan.workerModel, 'sonnet');
    assert.deepEqual(models(log), ['sonnet', 'sonnet']);
    assert.deepEqual(log.saved, []);
  });
}

test('Approve without workerModel: the pref as today, nothing saved', async () => {
  const { orch, log } = setup({ prefModel: 'fable' });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workerModel, 'fable');
  assert.deepEqual(log.saved, []);
});

test('default stays Opus: no worker settings dep, no workerModel', async () => {
  const { orch, log } = setup({ extraDeps: { workerSettings: undefined } });
  const { plan } = await orch.makePlan(ctx);
  assert.equal(plan.workerModel, 'opus');
  const res = await orch.launch(approve(plan));
  assert.equal(res.plan.workerModel, 'opus');
  assert.deepEqual(models(log), ['opus', 'opus']);
});

test('a started run never changes: a later launch with another workerModel is ignored', async () => {
  const packages = [PACKAGES[0], { ...PACKAGES[1], dependsOn: ['a'] }];
  const { orch, log } = setup({ packages });
  const { plan } = await orch.makePlan(ctx);
  const first = await orch.launch(approve(plan, { workerModel: 'sonnet' }));
  assert.equal(first.plan.started, true);
  assert.deepEqual(log.saved, ['sonnet']);
  // Launch the dependent package by hand, asking for another model.
  const second = await orch.launch({ planId: plan.id, ids: ['b'], prompts: {}, workerModel: 'fable' });
  assert.equal(second.ok, true);
  assert.equal(second.plan.workerModel, 'sonnet');
  assert.deepEqual(models(log), ['sonnet', 'sonnet']);
  assert.deepEqual(log.saved, ['sonnet']);
});

test('a refused launch (merge declined) saves nothing and changes nothing', async () => {
  const { orch, log } = setup({ extraDeps: { confirmMerge: async () => false } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { integration: 'merge', workerModel: 'fable' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'mergeDeclined');
  assert.deepEqual(log.saved, []);
  assert.equal(orch.view().workerModel, 'opus');
});

test('a scheduled start freezes the chosen model too', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'sonnet', schedule: { kind: 'time', at: '03:00' } }));
  assert.equal(res.ok, true);
  assert.ok(res.plan.scheduledAt);
  assert.equal(res.plan.workerModel, 'sonnet');
  assert.deepEqual(log.saved, ['sonnet']);
  assert.equal(log.sessions.length, 0);
});

test('a scheduled run keeps its model: "start now" with another workerModel changes nothing', async () => {
  const { orch, log } = setup();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch(approve(plan, { workerModel: 'sonnet', schedule: { kind: 'time', at: '03:00' } }));
  const now = await orch.launch(approve(plan, { workerModel: 'fable' }));
  assert.equal(now.ok, true);
  assert.equal(now.plan.workerModel, 'sonnet');
  assert.deepEqual(models(log), ['sonnet', 'sonnet']);
  assert.deepEqual(log.saved, ['sonnet']);
});

test('a Free-only run saves no worker model', async () => {
  const { orch, log } = setup({ extraDeps: { freeProfileId: () => 'free-a' } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workers: 'free', workerModel: 'fable' }));
  assert.equal(res.ok, true);
  assert.equal(res.plan.workers, 'free');
  assert.deepEqual(log.saved, []);
  assert.notEqual(res.plan.workerModel, 'fable');
});

test('a pref save that throws does not stop the launch', async () => {
  const { orch, log } = setup({ extraDeps: { saveWorkerModel: () => { throw new Error('disk full'); } } });
  const { plan } = await orch.makePlan(ctx);
  const res = await orch.launch(approve(plan, { workerModel: 'sonnet' }));
  assert.equal(res.ok, true);
  assert.deepEqual(models(log), ['sonnet', 'sonnet']);
});

test("'plan' run: a package the planner gave no model runs on Opus", async () => {
  const { orch, log } = setup({ packages: [{ ...PACKAGES[0], model: undefined }] });
  const { plan } = await orch.makePlan(ctx);
  await orch.launch(approve(plan, { workerModel: 'plan' }));
  assert.equal(log.sessions.length, 1);
  // makePlan stores a missing / unknown planner model as null.
  assert.equal(orch.view().packages[0].model, null);
  assert.equal(log.sessions[0].task.model, 'opus');
  assert.equal(rules.packageModelOf(orch.view().packages[0], 'plan'), 'opus');
});

test('view packages carry modelOverride for the badge', async () => {
  const { orch } = setup();
  const { plan } = await orch.makePlan(ctx);
  assert.equal(plan.packages[0].modelOverride, null);
});

// ---- badge helper: main rule and its renderer twin ---------------------------

const CASES = [
  { name: 'override wins over the run', pkg: { modelOverride: 'opus', model: 'sonnet' }, run: 'sonnet', want: 'opus' },
  { name: 'override wins over plan', pkg: { modelOverride: 'sonnet', model: 'opus' }, run: 'plan', want: 'sonnet' },
  { name: 'plan: the planner pick', pkg: { model: 'sonnet' }, run: 'plan', want: 'sonnet' },
  { name: 'plan: free -> Sonnet', pkg: { model: 'free' }, run: 'plan', want: 'sonnet' },
  { name: 'plan: missing -> Opus', pkg: { model: null }, run: 'plan', want: 'opus' },
  { name: 'plan: empty -> Opus', pkg: { model: '' }, run: 'plan', want: 'opus' },
  { name: 'plan: no package -> Opus', pkg: null, run: 'plan', want: 'opus' },
  { name: 'run choice ignores the pick', pkg: { model: 'sonnet' }, run: 'fable', want: 'fable' },
  { name: 'run choice for a free pick', pkg: { model: 'free' }, run: 'opus', want: 'opus' },
  { name: 'no run choice -> Opus', pkg: { model: 'sonnet' }, run: undefined, want: 'opus' },
  { name: 'empty override is no override', pkg: { modelOverride: '', model: 'sonnet' }, run: 'plan', want: 'sonnet' },
  // The known gap: a 'plan' / pool run's agy pick names agy, never a Claude --model.
  { name: 'plan: an agy:<id> pick stays agy', pkg: { model: 'agy:gemini-4-argon-high' }, run: 'plan', want: 'agy:gemini-4-argon-high' },
  { name: 'plan: plain agy pick stays agy', pkg: { model: 'agy' }, run: 'plan', want: 'agy' },
  { name: 'plan: an override beats the agy pick (rescue)', pkg: { model: 'agy:gemini-4-argon-high', modelOverride: 'opus' }, run: 'plan', want: 'opus' },
];

for (const c of CASES) {
  test(`badge: ${c.name}`, () => {
    assert.equal(main.packageModelOf(c.pkg, c.run), c.want);
    assert.equal(rules.packageModelOf(c.pkg, c.run), c.want);
  });
}

test('badgeModelOf: Free-only has no badge; a hybrid free package says free until handed over', () => {
  assert.equal(rules.badgeModelOf({ model: 'opus' }, 'opus', 'free'), null);
  assert.equal(rules.badgeModelOf({ model: 'free' }, 'opus', 'hybrid'), 'free');
  assert.equal(rules.badgeModelOf({ model: 'free' }, 'plan', 'hybrid'), 'free');
  // A hand-over to Sonnet (orchestraHybrid.js HAND_OVER_MODEL) is an override.
  assert.equal(rules.badgeModelOf({ model: 'free', modelOverride: 'sonnet' }, 'opus', 'hybrid'), 'sonnet');
  assert.equal(rules.badgeModelOf({ model: 'opus' }, 'plan', 'hybrid'), 'opus');
  assert.equal(rules.badgeModelOf({ model: 'sonnet' }, 'fable', 'claude'), 'fable');
  assert.equal(rules.badgeModelOf({ model: null }, 'plan', 'claude'), 'opus');
});

test('runWorkerModel: picked before the start, frozen after', () => {
  assert.equal(rules.runWorkerModel({ started: false, workerModel: 'opus' }, 'sonnet'), 'sonnet');
  assert.equal(rules.runWorkerModel({ started: false, workerModel: 'fable' }, null), 'fable');
  assert.equal(rules.runWorkerModel({ started: false, workerModel: 'bogus' }, 'bogus'), 'opus');
  assert.equal(rules.runWorkerModel({ started: true, workerModel: 'fable' }, 'sonnet'), 'fable');
  assert.equal(rules.runWorkerModel({ started: false, scheduledAt: 1, workerModel: 'fable' }, 'sonnet'), 'fable');
  assert.equal(rules.runWorkerModel(null, null), 'opus');
});

test('modelName: product names, raw id otherwise', () => {
  assert.equal(rules.modelName('opus'), 'Opus');
  assert.equal(rules.modelName('sonnet'), 'Sonnet');
  assert.equal(rules.modelName('fable'), 'Fable');
  assert.equal(rules.modelName('agy'), 'Antigravity');
  assert.equal(rules.modelName('auto:easy'), 'auto:easy');
  assert.equal(rules.modelName('constructor'), 'constructor');
  assert.equal(rules.modelName(null), '');
  assert.equal(rules.modelName(ARGON), 'Antigravity - gemini-4-argon-medium');
});

test('badgeModelOf: an agy run names its variant; a hybrid agy:<id> pick names its own', () => {
  assert.equal(rules.badgeModelOf({ model: 'sonnet' }, ARGON, 'agy'), ARGON);
  assert.equal(rules.badgeModelOf({ model: 'sonnet' }, 'opus', 'agy'), 'agy');
  assert.equal(rules.badgeModelOf({ model: 'agy:gemini-3.8-flash-low' }, 'opus', 'hybrid'), 'agy:gemini-3.8-flash-low');
  assert.equal(rules.badgeModelOf({ model: 'agy:gemini-3.8-flash-low', modelOverride: 'sonnet' }, 'opus', 'hybrid'), 'sonnet');
  assert.equal(rules.badgeModelOf({ model: 'opus' }, ARGON, 'claude'), ARGON);
  assert.equal(rules.badgeModelOf({ modelOverride: ARGON }, 'opus', 'claude'), ARGON);
});

test('workerModelChoices: live variants follow plain agy; a saved variant stays offered', () => {
  const live = ['agy:gemini-3.8-flash-low', ARGON, 'agy:--bad', 'opus'];
  assert.deepEqual(rules.workerModelChoices(live, 'opus'), ['opus', 'sonnet', 'fable', 'agy', 'agy:gemini-3.8-flash-low', ARGON, 'plan']);
  assert.deepEqual(rules.workerModelChoices([], ARGON), ['opus', 'sonnet', 'fable', 'agy', ARGON, 'plan']);
  assert.deepEqual(rules.workerModelChoices(null, null), [...ORCHESTRA_WORKER_MODELS]);
  assert.deepEqual(phone.workerModelOptions(ARGON), ['opus', 'sonnet', 'fable', 'agy', ARGON, 'plan']);
  assert.deepEqual(phone.workerModelOptions('opus'), [...ORCHESTRA_WORKER_MODELS]);
});

test('agyBadgeText: plain agy adds what the transcript reported; anything else is unchanged', () => {
  assert.equal(rules.agyBadgeText('agy', 'Antigravity', 'gemini-4-argon-medium'), 'Antigravity - gemini-4-argon-medium');
  assert.equal(rules.agyBadgeText('agy', 'Antigravity', ''), 'Antigravity');
  assert.equal(rules.agyBadgeText('agy', 'Antigravity', null), 'Antigravity');
  assert.equal(rules.agyBadgeText(ARGON, 'Antigravity - Gemini 4 Argon (Medium)', 'other'), 'Antigravity - Gemini 4 Argon (Medium)');
  assert.equal(rules.agyBadgeText('opus', 'Opus', 'x'), 'Opus');
});

test('agy:<id> worker models load everywhere (main, renderer, phone, snapshot); junk does not', () => {
  assert.equal(main.normalizeWorkerModel(ARGON), ARGON);
  assert.equal(rules.normalizeWorkerModel(ARGON), ARGON);
  assert.equal(phone.planDraft({ planId: 'p', packages: [], workerModel: ARGON }).workerModel, ARGON);
  for (const bad of ['agy:', 'agy:--print', 'agy:a b', `agy:${'a'.repeat(81)}`, 'AGY:x']) {
    assert.equal(main.normalizeWorkerModel(bad), null, bad);
    assert.equal(rules.normalizeWorkerModel(bad), null, bad);
  }
});

test('the badAgyModel refusal has pl and en text', () => {
  const hud = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = hud.indexOf('\n  en: {');
  assert.ok(hud.slice(0, enAt).includes("'orch.fail.badAgyModel':"));
  assert.ok(hud.slice(enAt).includes("'orch.fail.badAgyModel':"));
});

// ---- allow-lists in line ------------------------------------------------------

test('every worker-model allow-list matches src/uiprefs.js', () => {
  assert.deepEqual(main.ORCHESTRA_WORKER_MODELS, ORCHESTRA_WORKER_MODELS);
  assert.deepEqual(rules.WORKER_MODELS, ORCHESTRA_WORKER_MODELS);
  assert.deepEqual(PLAN_WORKER_MODELS, ORCHESTRA_WORKER_MODELS);
  assert.deepEqual(phone.WORKER_MODELS, ORCHESTRA_WORKER_MODELS);
  assert.equal(main.DEFAULT_WORKER_MODEL, 'opus');
  assert.equal(rules.DEFAULT_WORKER_MODEL, 'opus');
  assert.equal(phone.DEFAULT_WORKER_MODEL, 'opus');
});

// ---- strings -------------------------------------------------------------------

test('the Workers model strings exist in pl and en (HUD and phone)', () => {
  const hud = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = hud.indexOf('\n  en: {');
  assert.ok(enAt > 0);
  for (const key of ['orch.workerModel', 'orch.workerModel.hint', 'orch.pkgModel.free', 'orchset.model.plan']) {
    assert.ok(hud.slice(0, enAt).includes(`'${key}':`), `pl ${key}`);
    assert.ok(hud.slice(enAt).includes(`'${key}':`), `en ${key}`);
  }
  const mobile = fs.readFileSync(path.join(ROOT, 'mobile/src/i18n.js'), 'utf8');
  const mobileEn = mobile.indexOf('\n  en: {');
  assert.ok(mobileEn > 0);
  for (const key of ['gmWorkerModel', 'gmWorkerModelPlan']) {
    assert.ok(mobile.slice(0, mobileEn).includes(`${key}:`), `phone pl ${key}`);
    assert.ok(mobile.slice(mobileEn).includes(`${key}:`), `phone en ${key}`);
  }
});
