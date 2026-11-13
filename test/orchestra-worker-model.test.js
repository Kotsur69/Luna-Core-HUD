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

for (const bad of ['gpt-5', 'OPUS', '', 42, { model: 'opus' }, ['sonnet'], true]) {
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
  assert.equal(rules.modelName('auto:easy'), 'auto:easy');
  assert.equal(rules.modelName('constructor'), 'constructor');
  assert.equal(rules.modelName(null), '');
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
