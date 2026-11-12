// ============================================================================
// Phone God Mode A: the signed godmode.* host commands (src/hostgodmode.js)
// ----------------------------------------------------------------------------
// Fake controllers in a real registry. The payload is untrusted even when
// signed: every field is checked, refusals reuse the HUD's reasons, results
// carry no paths. A headless `--host` refuses every kind with needsHud.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostGodmode, needsHudHandlers, KINDS } = require('../src/hostgodmode.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');
const { registerOrchestraIpc } = require('../src/orchestraIpc.js');
const { todoSelection } = require('../src/orchestraPlanStart.js');
const { withLive, parseGodmodePeer, plansFrom } = require('../src/godmodesnapshot.js');
const { createLivePublisher } = require('../src/godmodelivepub.js');
const { createHostPush } = require('../src/hostpush.js');
const { hostSnapshot, parseHostPeer } = require('../src/hostsnapshot.js');
const { createHostSwitch } = require('../src/hostswitch.js');

const REPO = '/home/mati/repos/alpha-repo';
const NOW = Date.UTC(2026, 10, 8, 12);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** A controller double: records calls; makePlan waits on `planning` when set. */
function fakeController() {
  const calls = [];
  const state = { view: null, busy: false, running: false, planning: null, killResult: true, launch: null, retry: null, finish: null, discard: null };
  const rec = (name, fn) => (...args) => {
    calls.push([name, ...args]);
    return fn(...args);
  };
  return {
    calls,
    state,
    view: () => state.view,
    planWait: () => null,
    isBusy: () => state.busy,
    isRunning: () => state.running,
    makePlan: rec('makePlan', async () => {
      const res = state.planning ? await state.planning.promise : { ok: true, plan: state.view };
      if (res && res.ok) state.view = res.plan;
      return res;
    }),
    launch: rec('launch', (payload) => (state.launch ? state.launch(payload) : Promise.resolve({ ok: true, plan: { ...state.view, started: true } }))),
    kill: rec('kill', () => state.killResult),
    retry: rec('retry', (payload) => (state.retry ? state.retry(payload) : Promise.resolve({ ok: true }))),
    finishRun: rec('finishRun', () => (state.finish ? state.finish() : Promise.resolve({ ok: true }))),
    discard: rec('discard', () => {
      if (state.discard) return state.discard();
      state.view = null;
      return { ok: true };
    }),
  };
}

const planView = (id = 'pabc123', extra = {}) => ({
  id,
  started: false,
  killed: false,
  errors: [],
  packages: [
    { id: 'core', title: 'Core module', dependsOn: [], model: 'opus', todos: ['Add login'], state: 'pending', prompt: 'secret prompt' },
    { id: 'ui', title: 'UI', dependsOn: ['core'], model: 'sonnet', todos: ['Add login', 'Dark mode'], state: 'pending' },
  ],
  ...extra,
});

function setup({ blocked = [], todos } = {}) {
  const controllers = {};
  const registry = createOrchestraRegistry({
    makeController: (projectId) => {
      const c = fakeController();
      controllers[projectId] = c;
      return c;
    },
  });
  const projects = [
    { id: 'alpha', label: 'Alpha', path: REPO },
    { id: 'nofolder', label: 'Gone', path: '/missing/gone' },
  ];
  const tabs = [];
  const sent = [];
  const pushes = [];
  const logs = [];
  let changes = 0;
  const gm = createHostGodmode({
    registry,
    projects: () => projects,
    repoFor: (session) => {
      const p = projects.find((x) => x.id === session.projectId);
      return p && p.id !== 'nofolder' ? p.path : null;
    },
    godModeBlock: (projectId) => (blocked.includes(projectId) ? { ok: false, error: 'lunasWorkActive', message: `Luna's Work runs in ${REPO}` } : null),
    toolEnv: () => ({ PATH: '/bin' }),
    send: (channel, payload) => sent.push([channel, payload]),
    maxTodoItems: 5,
    openTab: (projectId) => {
      const tab = { id: `s${tabs.length + 1}`, projectId, profileId: 'cloud', cwd: REPO };
      tabs.push(tab);
      return tab;
    },
    readTodos: () =>
      todos || [
        { at: 1, text: 'Add login', done: false },
        { at: 2, text: 'Dark mode', done: false },
        { at: 3, text: 'Done already', done: true },
      ],
    onChange: () => {
      changes += 1;
    },
    log: (line) => logs.push(line),
    seq: () => 'r1',
  });
  gm.attach((kind, info) => pushes.push([kind, info]));
  /** A controller with a ready plan on `projectId`. */
  const withPlan = (projectId = 'alpha', view = planView()) => {
    const c = registry.ensure(projectId);
    c.state.view = view;
    return c;
  };
  const run = (kind, payload) => gm.handlers[kind](payload, { kind });
  return { gm, registry, controllers, tabs, sent, pushes, logs, changes: () => changes, withPlan, run };
}

const noPath = (value) => assert.ok(!JSON.stringify(value).includes('/home/'), `no path in ${JSON.stringify(value)}`);

// ---- godmode.plan ---------------------------------------------------------

test('plan: answers {status:planning} at once, opens a new tab and plans there', async () => {
  const s = setup();
  const c = s.registry.ensure('alpha');
  c.state.planning = deferred();
  const res = await s.run('godmode.plan', { projectId: 'alpha', todoAts: [1, 2, 2] });
  assert.deepEqual(res, { status: 'planning', projectId: 'alpha' });
  assert.equal(s.tabs.length, 1, 'a new HUD tab in the project');
  assert.equal(s.tabs[0].projectId, 'alpha');
  const [, ctx] = c.calls.find((x) => x[0] === 'makePlan');
  assert.deepEqual(ctx, { projectId: 'alpha', repoPath: REPO, profileId: 'cloud', env: { PATH: '/bin' }, todoAts: [1, 2], plannerEffort: 'high' });
  const [planning] = s.gm.plans();
  assert.equal(planning.state, 'planning');
  assert.deepEqual(planning.todos, ['Add login', 'Dark mode']);
  assert.equal(planning.repoName, 'alpha-repo');
  noPath(planning);
  assert.ok(s.changes() >= 1, 'the snapshot is poked');
  // A second phone plan always opens another tab - but not while one is planning.
  assert.deepEqual(await s.run('godmode.plan', { projectId: 'alpha' }), { status: 'refused', error: 'busy' });
  assert.equal(s.tabs.length, 1);
});

test('plan ready: lands in the snapshot as ready and pushes planReady with the repo name', async () => {
  const s = setup();
  const c = s.registry.ensure('alpha');
  c.state.planning = deferred();
  await s.run('godmode.plan', { projectId: 'alpha' });
  // The plan view names the run's worker model (the saved pref until Approve).
  c.state.planning.resolve({ ok: true, plan: planView('pabc123', { workerModel: 'sonnet' }) });
  await flush();
  assert.deepEqual(s.pushes, [['planReady', { key: 'plan:r1', repo: 'alpha-repo' }]]);
  assert.ok(s.sent.some(([ch, p]) => ch === 'orchestra:changed' && p.projectId === 'alpha'), 'the HUD board repaints');
  const plans = s.gm.plans();
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0], {
    planId: 'pabc123',
    projectId: 'alpha',
    repoName: 'alpha-repo',
    state: 'ready',
    errors: [],
    packages: [
      { id: 'core', title: 'Core module', deps: [], model: 'opus' },
      { id: 'ui', title: 'UI', deps: ['core'], model: 'sonnet' },
    ],
    todos: ['Add login', 'Dark mode'],
    workerModel: 'sonnet',
  });
  assert.ok(!JSON.stringify(plans).includes('secret prompt'), 'no prompts');

  // Through the snapshot writer and the phone's reader.
  const data = withLive(null, { plans }, { machine: 'KT-PC', now: NOW });
  assert.equal(data.plans[0].state, 'ready');
  const peer = parseGodmodePeer({ machine: 'KT-PC', data }, NOW);
  assert.equal(peer.plans[0].planId, 'pabc123');
  assert.equal(peer.plans[0].workerModel, 'sonnet', 'the phone select opens on it');
  assert.deepEqual(plansFrom([{ machine: 'KT-PC', data }], NOW).map((p) => [p.machine, p.projectId, p.state]), [['KT-PC', 'alpha', 'ready']]);
});

test('plan failed: a refusal or a plan with errors pushes planFailed and shows failed', async () => {
  const s = setup();
  const c = s.registry.ensure('alpha');
  c.state.planning = deferred();
  await s.run('godmode.plan', { projectId: 'alpha', todoAts: [4] });
  c.state.planning.resolve({ ok: false, error: 'noneSelected' });
  await flush();
  assert.deepEqual(s.pushes, [['planFailed', { key: 'plan:r1', repo: 'alpha-repo' }]]);
  const [failed] = s.gm.plans();
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.errors, ['noneSelected']);
  // Discard clears a failed phone plan that has no controller plan.
  assert.deepEqual(await s.run('godmode.discard', { projectId: 'alpha' }), { status: 'discarded', projectId: 'alpha' });
  assert.deepEqual(s.gm.plans(), []);

  // A plan whose packages failed validation.
  const t = setup();
  const d = t.registry.ensure('alpha');
  d.state.planning = deferred();
  await t.run('godmode.plan', { projectId: 'alpha' });
  d.state.planning.resolve({ ok: true, plan: planView('pbad1', { errors: [`cycle in ${REPO}/plan.json`] }) });
  await flush();
  assert.deepEqual(t.pushes.map((p) => p[0]), ['planFailed']);
  const [bad] = t.gm.plans();
  assert.equal(bad.state, 'failed');
  // The writer scrubs paths from errors before anything leaves the PC.
  const data = withLive(null, { plans: [bad] }, { machine: 'KT-PC', now: NOW });
  noPath(data.plans);
});

test('plan: a thrown planner is a planFailed, logged, never thrown', async () => {
  const s = setup();
  const c = s.registry.ensure('alpha');
  c.state.planning = deferred();
  await s.run('godmode.plan', { projectId: 'alpha' });
  c.state.planning.reject(new Error('spawn failed'));
  await flush();
  assert.deepEqual(s.pushes.map((p) => p[0]), ['planFailed']);
  assert.equal(s.gm.plans()[0].state, 'failed');
  assert.ok(s.logs.some((l) => l.includes('spawn failed')));
});

test("plan refusals: bad payloads, unknown project, Luna's Work, no folder, busy - and no tab", async () => {
  const s = setup({ blocked: ['alpha'] });
  const cases = [
    [null, 'badPayload'],
    [['alpha'], 'badPayload'],
    [{ projectId: 42 }, 'badProject'],
    [{ projectId: '../etc' }, 'badProject'],
    [{ projectId: 'x'.repeat(81) }, 'badProject'],
    [{ projectId: 'ghost' }, 'unknownProject'],
    [{ projectId: 'alpha', todoAts: ['1'] }, 'badTodos'],
    [{ projectId: 'alpha', todoAts: [1, Number.NaN] }, 'badTodos'],
    [{ projectId: 'alpha', todoAts: [1, 2, 3, 4, 5, 6] }, 'badTodos'],
    [{ projectId: 'alpha', todoAts: 'all' }, 'badTodos'],
    [{ projectId: 'alpha', todoAts: [] }, 'noneSelected'],
    [{ projectId: 'alpha' }, 'lunasWorkActive'],
    [{ projectId: 'nofolder' }, 'noRepo'],
  ];
  for (const [payload, error] of cases) {
    assert.deepEqual(await s.run('godmode.plan', payload), { status: 'refused', error }, JSON.stringify(payload));
  }
  assert.equal(s.tabs.length, 0, 'a refused command opens no tab');

  const t = setup();
  t.withPlan('alpha', planView('prun1', { started: true })).state.running = true;
  assert.deepEqual(await t.run('godmode.plan', { projectId: 'alpha' }), { status: 'refused', error: 'busy' });
  assert.equal(t.tabs.length, 0);
});

test('todoSelection: the rules orchestra:plan and godmode.plan share', () => {
  assert.deepEqual(todoSelection(undefined, 3), { valid: true, picked: null });
  assert.deepEqual(todoSelection(null, 3), { valid: true, picked: null });
  assert.deepEqual(todoSelection([2, 2, 1], 3), { valid: true, picked: [2, 1] });
  assert.deepEqual(todoSelection([1, 2, 3, 4], 3), { valid: false, picked: [] });
  assert.deepEqual(todoSelection([1, Infinity], 3), { valid: false, picked: [] });
  assert.deepEqual(todoSelection({ length: 1 }, 3), { valid: false, picked: [] });
});

// ---- godmode.launch -------------------------------------------------------

test('launch merge: the signed command skips the dialog; only checked fields reach the controller', async () => {
  const s = setup();
  const c = s.withPlan();
  const res = await s.run('godmode.launch', {
    projectId: 'alpha',
    planId: 'pabc123',
    ids: ['core', 'core'],
    integration: 'merge',
    free: false,
    releaseAfter: true,
    prompts: { core: 'rm -rf /' },
    mergeConfirmed: false,
  });
  assert.deepEqual(res, { status: 'launched', projectId: 'alpha', planId: 'pabc123' });
  const [, payload, trusted] = c.calls.find((x) => x[0] === 'launch');
  assert.deepEqual(payload, { planId: 'pabc123', ids: ['core'], integration: 'merge', free: false, releaseAfter: true });
  assert.deepEqual(trusted, { mergeConfirmed: true });
  assert.ok(s.sent.some(([ch]) => ch === 'orchestra:changed'));
});

test('launch: an allow-listed workerModel reaches the controller; a plan without one says null', async () => {
  for (const model of ['opus', 'sonnet', 'fable', 'plan']) {
    const s = setup();
    const c = s.withPlan();
    const res = await s.run('godmode.launch', { projectId: 'alpha', planId: 'pabc123', workerModel: model });
    assert.equal(res.status, 'launched');
    const [, payload] = c.calls.find((x) => x[0] === 'launch');
    assert.deepEqual(payload, { planId: 'pabc123', workerModel: model });
  }
  // null = not named: the PC's saved pref decides.
  const s = setup();
  const c = s.withPlan();
  await s.run('godmode.launch', { projectId: 'alpha', planId: 'pabc123', workerModel: null });
  assert.deepEqual(c.calls.find((x) => x[0] === 'launch')[1], { planId: 'pabc123' });
  assert.equal(s.gm.plans()[0].workerModel, null, 'an unknown model is never published');
});

test('launch from the renderer IPC never carries the trusted flag', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  let controller = null;
  const registry = createOrchestraRegistry({
    makeController: () => {
      controller = fakeController();
      controller.state.view = planView();
      return controller;
    },
  });
  registry.ensure('alpha');
  registerOrchestraIpc(ipcMain, {
    registry,
    projects: () => [{ id: 'alpha', path: REPO }],
    activeProjectId: () => 'alpha',
    resolveSession: () => null,
    repoFor: () => REPO,
    toolEnv: () => ({}),
    maxTodoItems: 5,
    godModeBlock: () => null,
    send: () => {},
    playCue: () => {},
    openExternal: () => {},
    openPath: async () => '',
    runsDir: () => '/runs',
    readUiPrefs: () => ({}),
    writeUiPrefs: () => {},
  });
  await handlers.get('orchestra:launch')({}, { projectId: 'alpha', planId: 'pabc123', integration: 'merge', mergeConfirmed: true });
  const call = controller.calls.find((x) => x[0] === 'launch');
  assert.equal(call.length, 2, 'the payload only - no trusted second argument');
});

test("launch refusals: unknown project, no plan, foreign or oversized ids, bad fields, Luna's Work", async () => {
  const s = setup();
  const c = s.withPlan();
  const base = { projectId: 'alpha', planId: 'pabc123' };
  const cases = [
    [{ projectId: 'ghost', planId: 'pabc123' }, 'unknownProject'],
    [{ ...base, planId: 'pother9' }, 'noPlan'],
    [{ ...base, planId: '../x' }, 'badPlan'],
    [{ ...base, planId: 7 }, 'badPlan'],
    [{ ...base, ids: ['core', 'evil'] }, 'badIds'],
    [{ ...base, ids: [] }, 'badIds'],
    [{ ...base, ids: 'core' }, 'badIds'],
    [{ ...base, ids: Array.from({ length: 51 }, () => 'core') }, 'badIds'],
    [{ ...base, ids: [{ id: 'core' }] }, 'badIds'],
    [{ ...base, integration: 'force-push' }, 'badIntegration'],
    [{ ...base, workerModel: 'gpt-5' }, 'badWorkerModel'],
    [{ ...base, workerModel: 'OPUS' }, 'badWorkerModel'],
    [{ ...base, workerModel: '' }, 'badWorkerModel'],
    [{ ...base, workerModel: 1 }, 'badWorkerModel'],
    [{ ...base, workerModel: ['opus'] }, 'badWorkerModel'],
    [{ ...base, workerModel: { toString: () => 'opus' } }, 'badWorkerModel'],
    [{ ...base, free: 'yes' }, 'badPayload'],
    [{ ...base, releaseAfter: 1 }, 'badPayload'],
  ];
  for (const [payload, error] of cases) {
    assert.deepEqual(await s.run('godmode.launch', payload), { status: 'refused', error }, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(c.calls.filter((x) => x[0] === 'launch').length, 0, 'nothing reached the controller');
  assert.deepEqual(await setup().run('godmode.launch', base), { status: 'refused', error: 'noPlan' });

  const blocked = setup({ blocked: ['alpha'] });
  blocked.withPlan();
  assert.deepEqual(await blocked.run('godmode.launch', base), { status: 'refused', error: 'lunasWorkActive' });

  // The controller's own refusal comes back as a status, not the message.
  const busy = setup();
  busy.withPlan().state.launch = async () => ({ ok: false, error: 'busy' });
  assert.deepEqual(await busy.run('godmode.launch', base), { status: 'refused', error: 'busy' });
});

test('launch: a long start answers launching at once and finishes in the background', async () => {
  const s = setup();
  const c = s.withPlan();
  const slow = deferred();
  c.state.launch = () => slow.promise;
  const res = await s.run('godmode.launch', { projectId: 'alpha', planId: 'pabc123' });
  assert.deepEqual(res, { status: 'launching', projectId: 'alpha', planId: 'pabc123' });
  slow.resolve({ ok: true, plan: planView('pabc123', { started: true }) });
  await flush();
  assert.ok(s.sent.some(([ch]) => ch === 'orchestra:changed'));
});

// ---- kill / retry / finish / discard ---------------------------------------

test("kill: stops the run even under Luna's Work; refusals without a run", async () => {
  const s = setup({ blocked: ['alpha'] });
  s.withPlan('alpha', planView('pabc123', { started: true }));
  assert.deepEqual(await s.run('godmode.kill', { projectId: 'alpha' }), { status: 'killed', projectId: 'alpha' });
  const t = setup();
  t.withPlan().state.killResult = false;
  assert.deepEqual(await t.run('godmode.kill', { projectId: 'alpha' }), { status: 'refused', error: 'noRun' });
  assert.deepEqual(await setup().run('godmode.kill', { projectId: 'alpha' }), { status: 'refused', error: 'noPlan' });
  assert.deepEqual(await setup().run('godmode.kill', { projectId: 'ghost' }), { status: 'refused', error: 'unknownProject' });
  assert.deepEqual(await setup().run('godmode.kill', 'alpha'), { status: 'refused', error: 'badPayload' });
});

test('retry: every failed and stalled package, counted; refusals', async () => {
  const s = setup();
  const view = planView('pabc123', {
    started: true,
    packages: [
      { id: 'a', state: 'failed' },
      { id: 'b', state: 'stalled' },
      { id: 'c', state: 'done' },
    ],
  });
  const c = s.withPlan('alpha', view);
  const res = await s.run('godmode.retry', { projectId: 'alpha' });
  assert.deepEqual(res, { status: 'retried', projectId: 'alpha', retried: 2, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(c.calls.filter((x) => x[0] === 'retry').map((x) => x[1]), [{ planId: 'pabc123', id: 'a' }, { planId: 'pabc123', id: 'b' }]);

  const none = setup();
  none.withPlan('alpha', planView('pabc123', { started: true, packages: [{ id: 'c', state: 'done' }] }));
  assert.deepEqual(await none.run('godmode.retry', { projectId: 'alpha' }), { status: 'refused', error: 'nothingToRetry' });

  const refusing = setup();
  refusing.withPlan('alpha', view).state.retry = async () => ({ ok: false, error: 'busy' });
  assert.deepEqual(await refusing.run('godmode.retry', { projectId: 'alpha' }), { status: 'refused', error: 'busy', failed: 2 });

  const blocked = setup({ blocked: ['alpha'] });
  blocked.withPlan('alpha', view);
  assert.deepEqual(await blocked.run('godmode.retry', { projectId: 'alpha' }), { status: 'refused', error: 'lunasWorkActive' });
  assert.deepEqual(await setup().run('godmode.retry', { projectId: 'alpha' }), { status: 'refused', error: 'noPlan' });
});

test("finish: the run's own mode, no override from the phone; refusals", async () => {
  const s = setup();
  const c = s.withPlan('alpha', planView('pabc123', { started: true }));
  assert.deepEqual(await s.run('godmode.finish', { projectId: 'alpha', integration: 'merge' }), { status: 'finished', projectId: 'alpha' });
  assert.deepEqual(c.calls.find((x) => x[0] === 'finishRun')[1], { planId: 'pabc123' });

  const active = setup();
  active.withPlan('alpha', planView('pabc123', { started: true })).state.finish = async () => ({ ok: false, error: 'runActive' });
  assert.deepEqual(await active.run('godmode.finish', { projectId: 'alpha' }), { status: 'refused', error: 'runActive' });

  const slow = setup();
  const wait = deferred();
  slow.withPlan('alpha', planView('pabc123', { started: true })).state.finish = () => wait.promise;
  assert.deepEqual(await slow.run('godmode.finish', { projectId: 'alpha' }), { status: 'finishing', projectId: 'alpha' });
  wait.resolve({ ok: true });

  const blocked = setup({ blocked: ['alpha'] });
  blocked.withPlan('alpha', planView('pabc123', { started: true }));
  assert.deepEqual(await blocked.run('godmode.finish', { projectId: 'alpha' }), { status: 'refused', error: 'lunasWorkActive' });
  assert.deepEqual(await setup().run('godmode.finish', { projectId: 'alpha' }), { status: 'refused', error: 'noPlan' });
});

test("discard: drops the plan; refused while busy, under Luna's Work, or with no plan", async () => {
  const s = setup();
  s.withPlan();
  assert.deepEqual(await s.run('godmode.discard', { projectId: 'alpha' }), { status: 'discarded', projectId: 'alpha' });
  assert.deepEqual(s.gm.plans(), []);

  const busy = setup();
  busy.withPlan().state.discard = () => ({ ok: false, error: 'runActive' });
  assert.deepEqual(await busy.run('godmode.discard', { projectId: 'alpha' }), { status: 'refused', error: 'runActive' });

  const blocked = setup({ blocked: ['alpha'] });
  blocked.withPlan();
  assert.deepEqual(await blocked.run('godmode.discard', { projectId: 'alpha' }), { status: 'refused', error: 'lunasWorkActive' });
  assert.deepEqual(await setup().run('godmode.discard', { projectId: 'alpha' }), { status: 'refused', error: 'noPlan' });
});

test('a HUD-made plan not started yet shows in plans(); a started one does not', () => {
  const s = setup();
  s.withPlan();
  assert.deepEqual(s.gm.plans().map((p) => [p.projectId, p.state, p.planId]), [['alpha', 'ready', 'pabc123']]);
  s.withPlan('alpha', planView('pabc123', { started: true }));
  assert.deepEqual(s.gm.plans(), []);
});

test('refusal errors never echo arbitrary controller text', async () => {
  const s = setup();
  s.withPlan().state.launch = async () => ({ ok: false, error: `failed at ${REPO}` });
  const res = await s.run('godmode.launch', { projectId: 'alpha', planId: 'pabc123' });
  assert.deepEqual(res, { status: 'refused', error: 'failed' });
});

test('a throwing handler is a plain refusal, its message only in the local log', async () => {
  const s = setup();
  const c = s.withPlan('alpha', planView('pabc123', { started: true }));
  c.state.launch = () => {
    throw new Error(`ENOENT ${REPO}/node_modules`);
  };
  c.state.view = planView();
  assert.deepEqual(await s.run('godmode.launch', { projectId: 'alpha', planId: 'pabc123' }), { status: 'refused', error: 'failed' });
  c.state.finish = () => Promise.reject(new Error(`git failed in ${REPO}`));
  assert.deepEqual(await s.run('godmode.finish', { projectId: 'alpha' }), { status: 'refused', error: 'failed' });
  assert.ok(s.logs.some((l) => l.includes('ENOENT')));
});

test('snapshot plans: titles and to-do texts are path-scrubbed', () => {
  const plan = {
    planId: 'pabc123',
    projectId: 'alpha',
    repoName: 'alpha-repo',
    state: 'ready',
    errors: [],
    packages: [{ id: 'core', title: `Fix ${REPO}/src/app.js`, deps: [], model: 'opus' }],
    todos: ['Clean C:\\Users\\mati\\repos\\alpha\\build.js'],
  };
  const data = withLive(null, { plans: [plan] }, { machine: 'KT-PC', now: NOW });
  noPath(data.plans);
  assert.ok(!JSON.stringify(data.plans).includes('Users'));
  assert.equal(data.plans[0].packages[0].title, 'Fix app.js');
});

// ---- headless host --------------------------------------------------------

test('headless --host: every godmode.* kind is refused with needsHud', async () => {
  const handlers = needsHudHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    assert.deepEqual(await handlers[kind]({ projectId: 'alpha', planId: 'pabc123' }), { status: 'refused', error: 'needsHud' }, kind);
  }
});

// ---- host snapshot: godmode only in HUD host mode --------------------------

test('host snapshot: godmode is true only when HUD host mode passes it', () => {
  assert.equal(hostSnapshot({}, NOW).godmode, false, 'headless default');
  assert.equal(hostSnapshot({ godmode: 'yes' }, NOW).godmode, false);
  const hud = hostSnapshot({ godmode: true }, NOW);
  assert.equal(hud.godmode, true);
  assert.equal(parseHostPeer({ machine: 'KT-PC', data: hud }, NOW).godmode, true);
  assert.equal(parseHostPeer({ machine: 'KT-PC', data: { ...hud, godmode: 1 } }, NOW).godmode, false);
});

test("host switch: HUD host mode hands startHost the HUD's God Mode", () => {
  const calls = [];
  const godmode = { handlers: {} };
  const control = createHostSwitch({
    machine: 'KT-PC',
    startHost: (opts) => {
      calls.push(opts);
      return { stop: () => {}, setDefault: () => {} };
    },
    hud: () => ({ cloud: { id: 'cloud' }, chatTabs: null, godmode }),
    windows: () => [],
    isDefault: () => false,
    log: () => {},
  });
  control.start();
  assert.equal(calls[0].godmode, godmode);
});

// ---- push + live publisher ------------------------------------------------

test('push: planReady / planFailed carry the machine and the repo folder name only', async () => {
  const bodies = [];
  const push = createHostPush({ invoke: async (body) => bodies.push(body), machine: 'KT-PC', log: () => {} });
  await push.plan('planReady', { key: 'plan:r1', repo: 'alpha-repo' });
  await push.plan('planFailed', { key: 'plan:r2', repo: '/home/mati/x' });
  await push.plan('planStarted', { key: 'plan:r3', repo: 'alpha-repo' });
  assert.deepEqual(bodies, [
    { event: 'planReady', machine: 'KT-PC', key: 'plan:r1', repo: 'alpha-repo' },
    { event: 'planFailed', machine: 'KT-PC', key: 'plan:r2' },
  ]);
});

test('push edge function: plan events map to text with the repo', async () => {
  const { notification, parsePushRequest } = await import('../supabase/functions/push/core.mjs');
  const req = parsePushRequest({ event: 'planReady', machine: 'KT-PC', key: 'plan:r1', repo: 'alpha-repo' });
  assert.equal(req.ok, true);
  assert.equal(notification(req, 'en').body, 'God Mode plan ready: alpha-repo on KT-PC');
  const failed = parsePushRequest({ event: 'planFailed', machine: 'KT-PC', key: 'plan:r2', repo: '../../etc' });
  assert.equal(failed.repo, undefined, 'an off-shape repo is dropped');
  assert.match(notification(failed, 'pl').body, /^Plan God Mode nieudany: God Mode na KT-PC$/);
});

test('live publisher: a plan changing state goes out at once', () => {
  let section = { live: null, lives: [], tabs: [], plans: [] };
  const sent = [];
  const pub = createLivePublisher({ build: () => section, publish: (x) => sent.push(x), now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  pub.poke();
  const before = sent.length;
  section = { ...section, plans: [{ projectId: 'alpha', planId: null, state: 'planning' }] };
  pub.poke();
  assert.equal(sent.length, before + 1);
  section = { ...section, plans: [{ projectId: 'alpha', planId: 'pabc123', state: 'ready' }] };
  pub.poke();
  assert.equal(sent.length, before + 2, 'urgent despite the throttle window');
});
