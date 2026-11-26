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
const { editorBoundReason } = require('../src/orchestraUnityVerify');

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

test('an agy build plans and works on agy (planner + Workers agy) in the agy profile env', async () => {
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => 'default',
    env: () => ({ PAID: '1' }),
    freeEnv: () => ({ FREE: '1' }),
    agyEnv: () => ({ AGY: '1' }),
  });
  const agyCards = CARDS.map((c) => ({ ...c, model: 'agy' }));
  const building = builder.build(buildOpts({ agy: true, cards: agyCards }));
  await tick();
  const ctx = orchestra.calls.makePlan[0];
  assert.equal(ctx.planner, 'agy');
  assert.equal(ctx.workers, 'agy');
  assert.deepEqual(ctx.env, { AGY: '1' });
  assert.deepEqual(orchestra.calls.launch, [{ planId: 'p1', integration: 'merge', workers: 'agy' }]);
  orchestra.settle({ planId: 'p1', killed: false, integration: { state: 'done' } });
  assert.equal((await building).ok, true);

  // A build without agy keeps God Mode's Claude defaults: no planner / workers key.
  const paid = builder.build(buildOpts());
  await tick();
  assert.equal('planner' in orchestra.calls.makePlan[1], false);
  assert.equal('workers' in orchestra.calls.makePlan[1], false);
  assert.deepEqual(orchestra.calls.makePlan[1].env, { PAID: '1' });
  assert.deepEqual(orchestra.calls.launch[1], { planId: 'p1', integration: 'merge' });
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await paid;
});

test('an agy build wins over free: never the free providers, never both flags', async () => {
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({}), freeEnv: () => ({ FREE: '1' }), agyEnv: () => ({ AGY: '1' }) });
  const building = builder.build(buildOpts({ agy: true, free: true }));
  await tick();
  assert.deepEqual(orchestra.calls.makePlan[0].env, { AGY: '1' });
  assert.deepEqual(orchestra.calls.launch[0], { planId: 'p1', integration: 'merge', workers: 'agy' });
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

test('an agy build without an agy profile is refused before God Mode is asked', async () => {
  for (const agyEnv of [undefined, () => null]) {
    const orchestra = fakeOrchestra();
    const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({ PAID: '1' }), ...(agyEnv ? { agyEnv } : {}) });
    assert.deepEqual(await builder.build(buildOpts({ agy: true })), { ok: false, error: 'noAgyProfile' });
    assert.equal(orchestra.calls.makePlan.length, 0, 'never planned on Claude instead');
    assert.equal(builder.isBuilding(), false, 'the build slot is free again');
  }
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

// Run lwmwxd1zal (2026-11-26): `unity command ...` verifies went red at the
// integration, where no Unity editor is open. A Unity build's plan has none.
const UNITY_CARDS = [
  { at: 1, text: 'Game clock', files: ['Assets/Scripts/GameClock.cs'] },
  { at: 2, text: 'HUD', files: ['Assets/Scripts/Hud.cs'] },
  { at: 3, text: 'Clock docs', files: ['docs/clock.md'] },
];
const unityPackages = () => [
  {
    id: 'game-clock',
    todoAts: [1],
    prompt: 'Build the clock. Commit when done.',
    files: ['Assets/Scripts/GameClock.cs'],
    dependsOn: [],
    verify: 'unity command script recompile && unity command test run --filter GameClockTests (edit mode: ok true, empty errors/warnings)',
  },
  { id: 'hud', todoAts: [2], prompt: 'Build the HUD.', files: ['Assets/Scripts/Hud.cs'], dependsOn: [], verify: 'Open the editor and check the HUD' },
  { id: 'docs', todoAts: [3], prompt: 'Write the docs.', files: ['docs/clock.md'], dependsOn: [], verify: 'grep -q "GameClock" docs/clock.md' },
];

function unityBuilder(isUnity) {
  const logs = [];
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => null,
    env: () => ({}),
    isUnityProject: () => isUnity,
    configureUnityMerge: async () => ({ ok: true }),
    log: (l) => logs.push(l),
  });
  const seen = [];
  const planner = builder.wrapPlanner(async (args) => (seen.push(args), { ok: true, raw: { packages: unityPackages() } }));
  return { orchestra, builder, planner, seen, logs };
}

test('a unity-adapter build: verify is always "" - every package\'s verify, a shell check too, moves into its prompt', async () => {
  const { orchestra, builder, planner, seen, logs } = unityBuilder(false);
  const building = builder.build({ projectId: 'game', repoPath: '/repo', cards: UNITY_CARDS, checkCommand: '', adapter: 'unity' });
  await tick();
  const planned = (await planner({ cwd: '/repo', extraPrompt: 'Re-size the packages.' })).raw.packages;

  assert.match(seen[0].extraPrompt, /^Re-size the packages\./, 'an extra request already there stays first');
  assert.match(seen[0].extraPrompt, /Unity project/);
  assert.match(seen[0].extraPrompt, /"verify" is always ""/);
  const byId = Object.fromEntries(planned.map((p) => [p.id, p]));
  const before = Object.fromEntries(unityPackages().map((p) => [p.id, p]));
  for (const p of planned) {
    assert.equal(p.verify, '', `${p.id}: no verify left`);
    assert.ok(p.prompt.startsWith(before[p.id].prompt), `${p.id}: the prompt itself is kept whole`);
    assert.ok(p.prompt.includes(before[p.id].verify), `${p.id}: its former verify is a check in the prompt`);
  }
  // No scene worker in this plan: every worker may use its own editor, as before.
  assert.match(byId['game-clock'].prompt, /Editor check: .*against your own Unity editor before you commit/);
  assert.match(byId.hud.prompt, /Editor check: /);
  assert.match(byId.docs.prompt, /Check: LunaCore runs no package verify command in this Unity project/);
  assert.doesNotMatch(byId.docs.prompt, /not run here/);
  assert.ok(logs.some((l) => /game-clock: verify in a Unity build \(unity, editor\) - moved into the prompt/.test(l)));
  assert.ok(logs.some((l) => /hud: verify in a Unity build \(prose, editor\)/.test(l)));
  assert.ok(logs.some((l) => /docs: verify in a Unity build \(shell, editor\)/.test(l)));

  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});

// Next to a scene worker, lunasworkScene tells every other package "Do not
// open the Unity editor": the moved check must not tell it to run one.
const SCENE_CARDS = [
  { at: 1, text: 'Game clock', files: ['Assets/Scripts/GameClock.cs'] },
  { at: 2, text: 'Hero sprite', files: ['Assets/Game/Art/hero.png', 'design/ASSETS.md'] },
  { at: 3, text: 'Place the clock in the scene', files: ['Assets/Scenes/Main.unity'] },
];
const scenePackages = () => [
  {
    id: 'game-clock',
    todoAts: [1],
    prompt: 'Build the clock.',
    files: ['Assets/Scripts/GameClock.cs'],
    dependsOn: [],
    verify: 'unity command script recompile && unity command test run --filter GameClockTests',
  },
  { id: 'art', todoAts: [2], prompt: 'Make the hero.', files: ['Assets/Game/Art/hero.png', 'design/ASSETS.md'], dependsOn: [], verify: 'test -f Assets/Game/Art/hero.png' },
  { id: 'scene', todoAts: [3], prompt: 'Place the clock.', files: ['Assets/Scenes/Main.unity'], dependsOn: ['game-clock'], verify: 'unity command console read' },
];

async function plannedScene(over = {}) {
  const logs = [];
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => null,
    env: () => ({}),
    isUnityProject: () => true,
    configureUnityMerge: async () => ({ ok: true }),
    log: (l) => logs.push(l),
    ...over,
  });
  const planner = builder.wrapPlanner(async () => ({ ok: true, raw: { packages: scenePackages() } }));
  const building = builder.build({ projectId: 'game', repoPath: '/repo', cards: SCENE_CARDS, checkCommand: '' });
  await tick();
  const planned = (await planner({})).raw.packages;
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
  return { byId: Object.fromEntries(planned.map((p) => [p.id, p])), logs };
}

test('a Unity build with a scene worker: the scene worker may use its editor; code and asset-prep packages may not', async () => {
  const { byId, logs } = await plannedScene();
  assert.deepEqual(Object.keys(byId).sort(), ['art', 'game-clock', 'scene-worker']);
  for (const p of Object.values(byId)) assert.equal(p.verify, '', `${p.id}: no verify left`);

  const sceneWorker = byId['scene-worker'].prompt;
  assert.match(sceneWorker, /Editor check: .*run it yourself against your own Unity editor/);
  assert.ok(sceneWorker.includes('unity command console read'), 'the scene worker keeps its check');
  assert.doesNotMatch(sceneWorker, /not run here/);

  for (const id of ['game-clock', 'art']) {
    const prompt = byId[id].prompt;
    assert.match(prompt, /Do not open the Unity editor|do not open Unity/, `${id}: lunasworkScene's note`);
    assert.match(prompt, /Check \(not run here\): do not open the Unity editor for it/, id);
    assert.match(prompt, /after the merge in the live Unity editor/, id);
    assert.match(prompt, /list this check as "not run here" in your hand-back/, id);
    assert.doesNotMatch(prompt, /run it yourself|against your own Unity editor/, `${id}: no contradiction`);
  }
  assert.match(byId['game-clock'].prompt, /review your C# carefully for compile errors \(usings, asmdef references, method signatures\)/);
  assert.ok(byId['game-clock'].prompt.includes('unity command test run --filter GameClockTests'));
  assert.ok(byId.art.prompt.includes('test -f Assets/Game/Art/hero.png'));
  assert.ok(logs.some((l) => /game-clock: verify in a Unity build \(unity, noEditor\)/.test(l)));
  assert.ok(logs.some((l) => /scene-worker: verify in a Unity build \(unity, editor\)/.test(l)));
});

test('a non-Unity build with scene work: verifies stay where the planner put them', async () => {
  const { byId } = await plannedScene({ isUnityProject: () => false });
  assert.equal(byId['game-clock'].verify, scenePackages()[0].verify);
  assert.equal(byId.art.verify, 'test -f Assets/Game/Art/hero.png');
  assert.doesNotMatch(byId['game-clock'].prompt, /not run here|Editor check/);
});

test('workerSettings: a Unity build tells the self-check so, and whether the check command is the profile\'s own', async () => {
  const run = async (opts, base) => {
    const orchestra = fakeOrchestra();
    const builder = createGodModeBuilder({ orchestra, profileId: () => null, env: () => ({}), isUnityProject: () => false, configureUnityMerge: async () => ({ ok: true }) });
    const building = builder.build({ projectId: 'game', repoPath: '/repo', cards: UNITY_CARDS, ...opts });
    await tick();
    const settings = builder.workerSettings(base);
    orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
    await building;
    return settings;
  };
  const godMode = { model: 'opus', checkCommand: 'npm test' };
  // No profile command: lunasworkRun.checkCommandFor handed over God Mode's.
  assert.deepEqual((await run({ checkCommand: 'npm test', adapter: 'unity' }, godMode)).unityBuild, { own: false });
  assert.deepEqual((await run({ checkCommand: '', adapter: 'unity' }, godMode)).unityBuild, { own: false });
  // The profile's own command differs from God Mode's.
  const own = await run({ checkCommand: 'pwsh tools/check.ps1', adapter: 'unity' }, godMode);
  assert.deepEqual(own.unityBuild, { own: true });
  assert.equal(own.checkCommand, 'pwsh tools/check.ps1');
  // A non-Unity build: no key, settings exactly as before.
  assert.deepEqual(await run({ checkCommand: 'npm run check', adapter: 'web' }, godMode), {
    model: 'plan',
    checkCommand: 'npm run check',
    integration: 'merge',
  });
});

test('a Unity project build (ProjectVersion.txt) gets the same; a non-Unity build is planned as before', async () => {
  const unity = unityBuilder(true);
  const building = unity.builder.build({ projectId: 'game', repoPath: '/repo', cards: UNITY_CARDS, checkCommand: '' });
  await tick();
  const planned = (await unity.planner({})).raw.packages;
  assert.ok(planned.every((p) => editorBoundReason(p.verify) === null));
  assert.match(unity.seen[0].extraPrompt, /Unity project/);
  unity.orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;

  const web = unityBuilder(false);
  const webBuild = web.builder.build({ projectId: 'site', repoPath: '/repo', cards: UNITY_CARDS, checkCommand: '', adapter: 'web' });
  await tick();
  const args = { cwd: '/repo' };
  const plain = (await web.planner(args)).raw.packages;
  assert.equal(web.seen[0], args, 'the planner args are untouched');
  assert.deepEqual(plain.map((p) => p.verify), unityPackages().map((p) => p.verify), 'verify untouched');
  web.orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await webBuild;
});

test('packageModel: haiku is not a God Mode worker model; agy:<id> cards keep their variant; no known card keeps the planner pick', () => {
  assert.equal(packageModel([1], new Map([[1, 'haiku']]), 'opus'), 'sonnet');
  assert.equal(packageModel([1, 2], new Map([[1, 'haiku'], [2, 'opus']]), 'sonnet'), 'opus');
  assert.equal(packageModel([1], new Map([[1, 'agy:gemini-4-argon-medium']]), 'sonnet'), 'agy:gemini-4-argon-medium');
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

test('asset-prep packages get the asset kit even when a custom builder kit lacks the asset tools', async () => {
  const ASSET_TOOLS = ['mcp__blender', 'mcp__comfyui', 'Bash(higgsfield:*)'];
  const KITS = {
    asset: { allowedTools: ASSET_TOOLS, disallowedTools: [], mcpConfigPath: '/kits/asset.json', addDirs: [], note: 'ASSET KIT NOTE' },
    builder: { allowedTools: ['mcp__unity'], disallowedTools: ASSET_TOOLS, mcpConfigPath: '/kits/builder.json', addDirs: [], note: 'BUILDER KIT NOTE' },
  };
  const roles = [];
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => null,
    env: () => ({}),
    isUnityProject: () => false,
    toolsFor: (req) => {
      roles.push(req.role);
      return KITS[req.role];
    },
  });
  const cards = [
    { at: 1, text: 'Hero sprite', files: ['art/hero.png', 'design/ASSETS.md'] },
    { at: 2, text: 'Login form', files: ['src/login.js'] },
    { at: 3, text: 'Place the hero', files: ['Assets/Scenes/Main.unity'] },
  ];
  const packages = [
    { id: 'art', todoAts: [1], prompt: 'make the hero', files: ['art/hero.png', 'design/ASSETS.md'], dependsOn: [] },
    { id: 'code', todoAts: [2], prompt: 'build login', files: ['src/login.js'], dependsOn: [] },
    { id: 'scene', todoAts: [3], prompt: 'place it', files: ['Assets/Scenes/Main.unity'], dependsOn: [] },
  ];
  const planner = builder.wrapPlanner(async () => ({ ok: true, raw: { packages } }));
  const building = builder.build({ projectId: 'game', repoPath: '/repo', cards, checkCommand: '' });
  await tick();
  const planned = (await planner({})).raw.packages;
  const byId = Object.fromEntries(planned.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['art', 'code', 'scene-worker']);
  // The kit note follows the same role as the launch kit.
  assert.ok(byId.art.prompt.endsWith('ASSET KIT NOTE'));
  assert.ok(byId['scene-worker'].prompt.endsWith('ASSET KIT NOTE'));
  assert.ok(byId.code.prompt.endsWith('BUILDER KIT NOTE'));

  const art = builder.workerTools(byId.art);
  assert.deepEqual(art.allowedTools, ASSET_TOOLS);
  assert.equal(art.mcpConfigPath, '/kits/asset.json');
  assert.deepEqual(art.disallowedTools, []);
  const code = builder.workerTools(byId.code);
  assert.equal(code.mcpConfigPath, '/kits/builder.json');
  assert.deepEqual(code.disallowedTools, ASSET_TOOLS);
  assert.equal(builder.workerTools(byId['scene-worker']).mcpConfigPath, '/kits/asset.json');
  // A package that also covers a code card is not asset-prep.
  assert.equal(builder.workerTools({ id: 'mixed', todoAts: [1, 2], files: [] }).mcpConfigPath, '/kits/builder.json');
  assert.ok(roles.includes('asset') && roles.includes('builder'));

  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
});
