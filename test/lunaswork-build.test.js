// ============================================================================
// Luna's Work builder (src/lunasworkBuild.js): one iteration's build as a God
// Mode run through makePlan's two hooks (card list, onRunSettled) and merge
// mode; the God Mode overlays (worker settings, planner models, merge
// confirmation) apply only while a build runs. A fake orchestra stands in.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGodModeBuilder, packageModel, planCard } = require('../src/lunasworkBuild');

const tick = () => new Promise((r) => setImmediate(r));

function fakeOrchestra(overrides = {}) {
  const o = {
    calls: { makePlan: [], launch: [], cancelPlanWait: 0 },
    settle: null,
    makePlan: async (ctx) => {
      o.calls.makePlan.push(ctx);
      o.settle = ctx.onRunSettled;
      return { ok: true, plan: { id: 'p1', errors: [] } };
    },
    launch: async (payload) => {
      o.calls.launch.push(payload);
      return { ok: true };
    },
    cancelPlanWait: () => {
      o.calls.cancelPlanWait += 1;
      return { ok: true };
    },
    ...overrides,
  };
  return o;
}

const CARDS = [
  { at: 1, text: 'Login form', details: 'brief', files: ['src/login.js'], size: 'L', model: 'opus', reason: 'large or risky card' },
  { at: 2, text: 'Header', size: 'S', model: 'sonnet', reason: 'small or medium card' },
];

function setup(overrides) {
  const orchestra = fakeOrchestra(overrides);
  const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({ PATH: 'x' }) });
  return { orchestra, builder };
}

const buildOpts = (extra = {}) => ({ projectId: 'game', repoPath: '/repo', cards: CARDS, checkCommand: 'npm run check', ...extra });

test("build plans exactly the Director's cards (Hook A) and launches in merge mode", async () => {
  const { orchestra, builder } = setup();
  const building = builder.build(buildOpts());
  await tick();
  const ctx = orchestra.calls.makePlan[0];
  assert.equal(ctx.projectId, 'game');
  assert.equal(ctx.repoPath, '/repo');
  assert.equal(ctx.profileId, 'default');
  assert.deepEqual(ctx.cards.map((c) => c.at), [1, 2]);
  assert.equal(ctx.cards[0].details, 'brief');
  assert.equal(ctx.cards[0].model, 'opus');
  assert.equal('reason' in ctx.cards[0], false, 'only planner fields reach God Mode');
  assert.equal(typeof ctx.onRunSettled, 'function');
  assert.deepEqual(orchestra.calls.launch, [{ planId: 'p1', integration: 'merge' }]);
  assert.equal(builder.isBuilding('game'), true);

  const integration = { state: 'done', skipped: [] };
  orchestra.settle({ planId: 'p1', killed: false, integration, plan: { packages: [] } });
  const res = await building;
  assert.equal(res.ok, true);
  assert.deepEqual(res.integration, integration);
  assert.equal(builder.isBuilding(), false);
});

test('a free build asks God Mode for the free providers, planning included', async () => {
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({ PAID: '1' }), freeEnv: () => ({ FREE: '1' }) });
  const building = builder.build(buildOpts({ free: true }));
  await tick();
  assert.deepEqual(orchestra.calls.launch, [{ planId: 'p1', integration: 'merge', free: true }]);
  assert.deepEqual(orchestra.calls.makePlan[0].env, { FREE: '1' });
  orchestra.settle({ planId: 'p1', killed: false, integration: { state: 'done' } });
  await building;

  // Not free: the paid env, whatever freeEnv says.
  const paid = builder.build(buildOpts());
  await tick();
  assert.deepEqual(orchestra.calls.makePlan[1].env, { PAID: '1' });
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await paid;
});

test('a kill while the merge is still running keeps the overlays until the merge is done', async () => {
  const { builder } = setup();
  const building = builder.build(buildOpts());
  await tick();
  builder.onChange({ id: 'p1', projectId: 'game', killed: true, integration: { state: 'running', running: true } });
  await tick();
  assert.equal(builder.workerSettings({ checkCommand: 'npm test' }).checkCommand, 'npm run check');
  assert.equal(builder.ownsMerge({ id: 'p1', projectId: 'game' }), true);
  builder.onChange({ id: 'p1', projectId: 'game', killed: true, integration: { state: 'failed', running: false } });
  const res = await building;
  assert.equal(res.killed, true);
  assert.equal(builder.ownsMerge({ id: 'p1', projectId: 'game' }), false);
});

test('the God Mode overlays apply only while a build runs', async () => {
  const { orchestra, builder } = setup();
  const base = { model: 'opus', integration: 'pr', checkCommand: 'npm test', permissionMode: 'bypassPermissions' };
  const own = { id: 'p1', projectId: 'game' };
  assert.equal(builder.workerSettings(base), base);
  assert.equal(builder.ownsMerge(own), false);

  const building = builder.build(buildOpts());
  await tick();
  assert.deepEqual(builder.workerSettings(base), {
    model: 'plan',
    integration: 'merge',
    checkCommand: 'npm run check',
    permissionMode: 'bypassPermissions',
  });
  assert.equal(builder.ownsMerge(own), true);
  // The merge confirmation is never given for any other plan.
  assert.equal(builder.ownsMerge({ id: 'p2', projectId: 'game' }), false);
  assert.equal(builder.ownsMerge({ id: 'p1', projectId: 'other' }), false);
  assert.equal(builder.ownsMerge(null), false);

  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
  assert.equal(builder.workerSettings(base), base);
  assert.equal(builder.ownsMerge(own), false);
});

test("Mati's open God Mode plan or planning wait on another project is never replaced: the build waits", async () => {
  const cases = [
    { view: { id: 'gm1', projectId: 'other', settled: false, killed: false, started: false, packages: [] }, wait: null },
    { view: null, wait: { state: 'waiting', projectId: 'other', resumeAt: 1 } },
  ];
  for (const { view, wait } of cases) {
    const { orchestra, builder } = setup({ view: () => view, planWait: () => wait });
    assert.deepEqual(await builder.build(buildOpts({ ownPlanIds: ['p0'] })), { ok: false, error: 'godModeBusy' });
    assert.equal(orchestra.calls.makePlan.length, 0);
  }
  // A settled or killed plan, or one this run made, may be replaced.
  for (const view of [
    { id: 'gm1', projectId: 'other', settled: true, killed: false },
    { id: 'gm1', projectId: 'other', settled: false, killed: true },
    { id: 'p0', projectId: 'game', settled: false, killed: false, packages: [] },
  ]) {
    const { orchestra, builder } = setup({ view: () => view, planWait: () => ({ state: 'failed' }) });
    const building = builder.build(buildOpts({ ownPlanIds: ['p0'] }));
    await tick();
    assert.equal(orchestra.calls.makePlan.length, 1, JSON.stringify(view));
    orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
    await building;
  }
});

test("an empty project check command keeps God Mode's own Final check command", async () => {
  const { orchestra, builder } = setup();
  const building = builder.build(buildOpts({ checkCommand: '' }));
  await tick();
  assert.equal(builder.workerSettings({ checkCommand: 'npm test -- --ci' }).checkCommand, 'npm test -- --ci');
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

test('wrapPlanner gives each package the strongest model of its cards, only during a build', async () => {
  const { orchestra, builder } = setup();
  const planned = {
    ok: true,
    raw: {
      packages: [
        { id: 'a', todoAts: [2], model: 'opus' },
        { id: 'b', todoAts: [1, 2], model: 'sonnet' },
        { id: 'c', todoAts: [99], model: 'sonnet' },
      ],
    },
  };
  const planner = builder.wrapPlanner(async () => planned);
  assert.equal(await planner({}), planned, 'God Mode alone: untouched');

  const building = builder.build(buildOpts());
  await tick();
  const res = await planner({});
  assert.deepEqual(res.raw.packages.map((p) => p.model), ['sonnet', 'opus', 'sonnet']);
  assert.equal(planned.raw.packages[1].model, 'sonnet', 'the planner result is not mutated');
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

test('packageModel: haiku is not a God Mode worker model; no known card keeps the planner pick', () => {
  assert.equal(packageModel([1], new Map([[1, 'haiku']]), 'opus'), 'sonnet');
  assert.equal(packageModel([1, 2], new Map([[1, 'haiku'], [2, 'opus']]), 'sonnet'), 'opus');
  assert.equal(packageModel([3], new Map([[1, 'opus']]), 'sonnet'), 'sonnet');
  assert.deepEqual(planCard({ at: 5, text: 't', reason: 'x', tags: ['a'] }), { at: 5, text: 't' });
});

test("a usage limit while planning: God Mode's own wait is cancelled and the controller gets the resume time", async () => {
  const { orchestra, builder } = setup({
    makePlan: async () => ({ ok: false, error: 'waiting', planWait: { state: 'waiting', resumeAt: 12345 } }),
  });
  const res = await builder.build(buildOpts());
  assert.deepEqual(res, { ok: false, error: 'limit', resumeAt: 12345 });
  assert.equal(orchestra.calls.cancelPlanWait, 1);
  assert.equal(builder.ownsMerge(), false);
});

test('God Mode busy, nothing left to build, plan errors and a failed launch', async () => {
  for (const error of ['busy', 'runActive']) {
    const { builder } = setup({ makePlan: async () => ({ ok: false, error }) });
    assert.deepEqual(await builder.build(buildOpts()), { ok: false, error: 'godModeBusy' });
  }
  const none = setup({ makePlan: async () => ({ ok: false, error: 'noTodos' }) });
  const res = await none.builder.build(buildOpts());
  assert.equal(res.ok, true);
  assert.equal(res.nothing, true);

  const bad = setup({ makePlan: async () => ({ ok: true, plan: { id: 'p1', errors: [{ code: 'cycle' }] } }) });
  assert.deepEqual(await bad.builder.build(buildOpts()), { ok: false, error: 'planErrors' });
  assert.equal(bad.orchestra.calls.launch.length, 0);

  const noFree = setup({ launch: async () => ({ ok: false, error: 'noFreeProfile' }) });
  assert.deepEqual(await noFree.builder.build(buildOpts({ free: true })), { ok: false, error: 'noFreeProfile' });

  const failed = setup({ makePlan: async () => ({ ok: false, error: 'noClaude', detail: 'x' }) });
  assert.deepEqual(await failed.builder.build(buildOpts()), { ok: false, error: 'noClaude', detail: 'x' });
});

test('a kill or a discard of the build plan settles the build (onRunSettled never fires for those)', async () => {
  const killed = setup();
  const building = killed.builder.build(buildOpts());
  await tick();
  killed.builder.onChange({ id: 'p1', killed: false });
  killed.builder.onChange({ id: 'p1', killed: true, integration: { state: 'idle' }, packages: [] });
  const res = await building;
  assert.equal(res.killed, true);
  assert.equal(res.ok, false);

  const discarded = setup();
  const pending = discarded.builder.build(buildOpts());
  await tick();
  discarded.builder.onChange(null);
  assert.deepEqual(await pending, { ok: false, error: 'discarded' });
});

test('the plan id is reported once God Mode made the plan', async () => {
  const { orchestra, builder } = setup();
  const ids = [];
  const building = builder.build(buildOpts({ onPlan: (id) => ids.push(id) }));
  await tick();
  assert.deepEqual(ids, ['p1']);
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

test('after a restart mid-build, the restored plan\'s pushed work is merged first (finishRun), not re-planned', async () => {
  const restored = {
    id: 'p7',
    projectId: 'game',
    settled: false,
    killed: false,
    packages: [
      { id: 'a', state: 'pushed', merged: false },
      { id: 'b', state: 'stalled', error: 'restarted', merged: false },
    ],
  };
  const finished = { ...restored, integration: { state: 'done', skipped: [] } };
  const finishes = [];
  const { orchestra, builder } = setup({
    view: () => restored,
    finishRun: async (payload) => {
      finishes.push({ payload, ownsMerge: builder.ownsMerge(restored), check: builder.workerSettings({ checkCommand: 'npm test' }).checkCommand });
      return { ok: true, plan: finished };
    },
  });
  const res = await builder.build(buildOpts({ resumePlanId: 'p7', ownPlanIds: ['p7'] }));
  assert.deepEqual(finishes, [{ payload: { planId: 'p7', integration: 'merge' }, ownsMerge: true, check: 'npm run check' }]);
  assert.equal(orchestra.calls.makePlan.length, 0);
  assert.equal(res.ok, true);
  assert.equal(res.resumed, true);
  assert.deepEqual(res.integration, finished.integration);
});

test('a restored plan with nothing pushed, an older own plan, or a settled one is planned afresh', async () => {
  for (const view of [
    { id: 'p7', projectId: 'game', settled: false, killed: false, packages: [{ id: 'a', state: 'stalled', merged: false }] },
    { id: 'p6', projectId: 'game', settled: false, killed: false, packages: [{ id: 'a', state: 'pushed', merged: false }] },
    { id: 'p7', projectId: 'game', settled: true, killed: false, packages: [{ id: 'a', state: 'pushed', merged: false }] },
  ]) {
    let finished = 0;
    const { orchestra, builder } = setup({ view: () => view, finishRun: async () => ((finished += 1), { ok: true }) });
    const building = builder.build(buildOpts({ resumePlanId: 'p7', ownPlanIds: ['p6', 'p7'] }));
    await tick();
    assert.equal(finished, 0);
    assert.equal(orchestra.calls.makePlan.length, 1);
    orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
    await building;
  }
});

test('a restored plan of another project is never finished as this build', async () => {
  const view = { id: 'p7', projectId: 'other', settled: false, killed: false, packages: [{ id: 'a', state: 'pushed', merged: false }] };
  let finished = 0;
  const { orchestra, builder } = setup({ view: () => view, finishRun: async () => ((finished += 1), { ok: true }) });
  assert.deepEqual(await builder.build(buildOpts({ resumePlanId: 'p7', ownPlanIds: [] })), { ok: false, error: 'godModeBusy' });
  assert.equal(finished, 0);
  assert.equal(orchestra.calls.makePlan.length, 0);
});

test('one build at a time; a throwing orchestra is a plain failure', async () => {
  const { orchestra, builder } = setup();
  const first = builder.build(buildOpts());
  await tick();
  assert.deepEqual(await builder.build(buildOpts()), { ok: false, error: 'godModeBusy' });
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await first;

  const broken = setup({
    makePlan: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(await broken.builder.build(buildOpts()), { ok: false, error: 'failed' });
  assert.equal(broken.builder.ownsMerge(), false);
});
