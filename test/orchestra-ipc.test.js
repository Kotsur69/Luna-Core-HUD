// ============================================================================
// God Mode v2 IPC (src/orchestraIpc.js, docs/tbc_docs/MULTI_GODMODE_PLAN.md A2) on a
// fake ipcMain: the renderer is untrusted, so every handler resolves its run
// in main - a validated projectId, a planId cross-checked against that run,
// or (no projectId, today's renderer) the active tab's run.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerOrchestraIpc, runSummary, MAX_PROJECT_ID_CHARS } = require('../src/orchestraIpc.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');
const orchestraFinishIpc = require('../src/orchestraFinishIpc.js');

const PR_URL = 'https://github.com/luna/core/pull/7';

/** A controller double that records what it was asked to do. */
function fakeController(projectId, view) {
  const calls = [];
  const rec = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const state = { view };
  return {
    calls,
    state,
    view: () => state.view,
    planWait: () => null,
    isRunning: () => false,
    isBusy: () => false,
    repoPath: () => null,
    planningRepo: () => null,
    ownsSession: () => false,
    makePlan: rec('makePlan', async (ctx) => {
      state.view = { id: `plan-${projectId}`, projectId: ctx.projectId, packages: [], suggestions: [] };
      return { ok: true, plan: state.view };
    }),
    launch: rec('launch', async () => ({ ok: true, plan: state.view })),
    discard: rec('discard', { ok: true }),
    retry: rec('retry', { ok: true }),
    kill: rec('kill', true),
    unschedule: rec('unschedule', { ok: true }),
    finishRun: rec('finishRun', { ok: true }),
    cancelPlanWait: rec('cancelPlanWait', { ok: true }),
    cancelSleep: rec('cancelSleep', { ok: true }),
    cancelShutdown: rec('cancelShutdown', { ok: true }),
    checkWake: rec('checkWake', { ok: true, reason: 'ok' }),
    setOptions: rec('setOptions', { ok: true }),
    abortFinalize: rec('abortFinalize', { ok: true }),
    resumeInterrupted: rec('resumeInterrupted', async () => ({ ok: true })),
    cancelResume: rec('cancelResume', { ok: true }),
    pauseForShutdown: rec('pauseForShutdown', { ok: true }),
  };
}

const view = (id, extra = {}) => ({
  id,
  started: true,
  killed: false,
  settled: false,
  packages: [{ id: 'a', prUrl: PR_URL, prompt: 'secret prompt' }],
  suggestions: [{ rule: 'Bash(npm test:*)' }],
  tally: { done: 1 },
  ...extra,
});

/**
 * Registers the handlers on a fake ipcMain. `runs` = {projectId: view|null}
 * (null = a controller with no plan yet).
 */
function setup({ runs = {}, active = 'alpha', blocked = [] } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
  const controllers = {};
  const registry = createOrchestraRegistry({
    makeController: (projectId) => {
      const c = fakeController(projectId, runs[projectId] === undefined ? null : runs[projectId]);
      controllers[projectId] = c;
      return c;
    },
  });
  for (const id of Object.keys(runs)) registry.ensure(id);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-orch-ipc-'));
  const out = { sent: [], opened: [], external: [], prefs: { orchestraAllowedTools: [] }, active, cues: [] };
  const sessions = {
    'tab-a': { id: 'tab-a', projectId: 'alpha', profileId: 'claude', repo: '/repo/alpha' },
    'tab-b': { id: 'tab-b', projectId: 'beta', profileId: 'claude', repo: '/repo/beta' },
    'tab-norepo': { id: 'tab-norepo', projectId: 'gamma', profileId: 'claude', repo: null },
  };
  registerOrchestraIpc(ipcMain, {
    registry,
    projects: () => [
      { id: 'alpha', label: 'Alpha', path: '/repo/alpha' },
      { id: 'beta', label: 'Beta', path: '/repo/beta' },
      { id: 'gamma', path: '/repo/gamma' },
    ],
    activeProjectId: () => out.active,
    resolveSession: (id) => (typeof id === 'string' && sessions[id]) || null,
    repoFor: (session) => session.repo,
    toolEnv: () => ({ PATH: 'x' }),
    maxTodoItems: 5,
    godModeBlock: (projectId) => (blocked.includes(projectId) ? { ok: false, error: 'lunasWorkActive' } : null),
    send: (channel, payload) => out.sent.push([channel, payload]),
    playCue: (key) => out.cues.push(key),
    openExternal: (url) => out.external.push(url),
    openPath: async (file) => {
      out.opened.push(file);
      return '';
    },
    runsDir: () => runsDir,
    readUiPrefs: () => out.prefs,
    writeUiPrefs: (patch) => {
      out.prefs = { ...out.prefs, ...patch };
    },
  });
  // The finished-run channels (resend email, release) live in their own
  // module; main registers both on the same ipcMain.
  out.resent = [];
  out.releaseAsked = [];
  orchestraFinishIpc.register(ipcMain, {
    runsDir: () => runsDir,
    resendRunEmail: async (planId) => (out.resent.push(planId), { ok: true }),
    planProject: (planId) => {
      const hit = registry.byPlanId(planId);
      return hit ? hit.projectId : undefined;
    },
    projects: () => [
      { id: 'alpha', path: '/repo/alpha' },
      { id: 'beta', path: '/repo/beta' },
    ],
    releaseTarget: (projectId) => (out.releaseAsked.push(projectId), null),
    cutRelease: async () => ({ ok: false }),
  });
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  const emit = (channel, ...args) => listeners.get(channel)({}, ...args);
  const cleanup = () => fs.rmSync(runsDir, { recursive: true, force: true });
  return { invoke, emit, controllers, registry, out, runsDir, cleanup, handlers, listeners };
}

const calledNames = (c) => c.calls.map((call) => call[0]);

test('an unknown or malformed projectId is refused before any controller is touched', async (t) => {
  const s = setup({ runs: { alpha: view('pa') } });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 'ghost' }), { ok: false, error: 'unknownProject' });
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 'x'.repeat(MAX_PROJECT_ID_CHARS + 1) }), { ok: false, error: 'badProject' });
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: '' }), { ok: false, error: 'badProject' });
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 7 }), { ok: false, error: 'badProject' });
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: { toString: () => 'alpha' } }), { ok: false, error: 'badProject' });
  // A registered project that has no run yet.
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 'beta' }), { ok: false, error: 'noPlan' });
  assert.equal(await s.invoke('orchestra:kill', { projectId: 'ghost' }), false);
  assert.equal(await s.invoke('orchestra:get', { projectId: 'ghost' }), null);
  assert.deepEqual(calledNames(s.controllers.alpha), [], 'alpha was never acted on');
  assert.equal(s.registry.get('ghost'), null, 'no controller is made for an unknown project');
});

test('a junk options argument or payload is refused', async (t) => {
  const s = setup({ runs: { alpha: view('pa') } });
  t.after(s.cleanup);
  for (const junk of ['alpha', 42, ['alpha'], true]) {
    assert.deepEqual(await s.invoke('orchestra:discard', junk), { ok: false, error: 'badPayload' }, JSON.stringify(junk));
    assert.equal(await s.invoke('orchestra:get', junk), null);
  }
  for (const junk of [null, undefined, 'pa', ['pa'], 5]) {
    assert.deepEqual(await s.invoke('orchestra:launch', junk), { ok: false, error: 'badPayload' });
    assert.deepEqual(await s.invoke('orchestra:retry', junk), { ok: false, error: 'badPayload' });
    assert.deepEqual(await s.invoke('orchestra:finish', junk), { ok: false, error: 'badPayload' });
    assert.deepEqual(await s.invoke('orchestra:unschedule', junk), { ok: false, error: 'badPayload' });
  }
  assert.deepEqual(await s.invoke('orchestra:cancel-power', 'reboot'), { ok: false, error: 'badPower' });
  assert.deepEqual(await s.invoke('orchestra:set-options', { rm: true }), { ok: false, error: 'badOptions' });
  assert.deepEqual(await s.invoke('orchestra:set-options', 'sleepOnLimit'), { ok: false, error: 'badOptions' });
  assert.deepEqual(await s.invoke('orchestra:allow', 'Bash(rm -rf:*)'), { ok: false, error: 'badRule' }, 'never logged by the run');
  assert.deepEqual(await s.invoke('orchestra:openReport', '../evil'), { ok: false, error: 'badId' });
  assert.deepEqual(calledNames(s.controllers.alpha), []);
});

test("a planId that is not the resolved run's plan is refused", async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  const wrong = { projectId: 'alpha', planId: 'pb', id: 'a' };
  assert.deepEqual(await s.invoke('orchestra:launch', wrong), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:retry', wrong), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:finish', wrong), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:unschedule', wrong), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:openReport', 'pb', { projectId: 'alpha' }), { ok: false, error: 'noPlan' });
  // No projectId: the planId itself names the run, and an unknown one names none.
  assert.deepEqual(await s.invoke('orchestra:launch', { planId: 'zzz' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:launch', { planId: 42 }), { ok: false, error: 'noPlan' });
  assert.deepEqual(calledNames(s.controllers.alpha), []);
  assert.deepEqual(calledNames(s.controllers.beta), []);
});

test('a matching projectId + planId reaches that run only', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  const res = await s.invoke('orchestra:launch', { projectId: 'beta', planId: 'pb', ids: null });
  assert.equal(res.ok, true);
  assert.deepEqual(calledNames(s.controllers.beta), ['launch']);
  assert.deepEqual(calledNames(s.controllers.alpha), []);
  assert.deepEqual(s.out.sent, [['orchestra:changed', { projectId: 'beta', view: view('pb') }]]);
  assert.deepEqual(s.out.cues, ['sfx.terminalNew']);
  assert.equal(await s.invoke('orchestra:kill', { projectId: 'beta' }), true);
  assert.deepEqual(calledNames(s.controllers.alpha), [], 'Kill on the board stops the shown run only');
});

test("no projectId falls back to the active tab's run, so today's renderer keeps working", async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') }, active: 'beta' });
  t.after(s.cleanup);
  assert.equal((await s.invoke('orchestra:get')).id, 'pb');
  assert.equal((await s.invoke('orchestra:get', {})).id, 'pb');
  assert.deepEqual(await s.invoke('orchestra:discard'), { ok: true });
  assert.deepEqual(calledNames(s.controllers.beta), ['discard']);
  // Plan-bearing calls without a projectId find the run by its plan id,
  // whichever tab is on screen.
  assert.equal((await s.invoke('orchestra:launch', { planId: 'pa', ids: null })).ok, true);
  assert.deepEqual(calledNames(s.controllers.alpha), ['launch']);
});

test('the fallback uses the only run when the active tab has none, and refuses to guess between several', async (t) => {
  const one = setup({ runs: { alpha: view('pa') }, active: 'gamma' });
  t.after(one.cleanup);
  assert.equal((await one.invoke('orchestra:get')).id, 'pa', 'the single-run board keeps showing it');
  assert.equal(await one.invoke('orchestra:kill'), true);

  const two = setup({ runs: { alpha: view('pa'), beta: view('pb') }, active: 'gamma' });
  t.after(two.cleanup);
  assert.equal(await two.invoke('orchestra:get'), null);
  assert.equal(await two.invoke('orchestra:kill'), false);
  assert.deepEqual(await two.invoke('orchestra:discard'), { ok: false, error: 'noPlan' });
  assert.deepEqual(calledNames(two.controllers.alpha), []);
  assert.deepEqual(calledNames(two.controllers.beta), []);
});

test('orchestra:plan takes the project, folder and profile from the tab, never from the page', async (t) => {
  const s = setup({ runs: {}, blocked: ['gamma'] });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:plan', 'nope', null), { ok: false, error: 'noTab' });
  assert.deepEqual(await s.invoke('orchestra:plan', { projectId: 'beta' }, null), { ok: false, error: 'noTab' });
  assert.deepEqual(await s.invoke('orchestra:plan', 'tab-norepo', null), { ok: false, error: 'lunasWorkActive' });
  const res = await s.invoke('orchestra:plan', 'tab-b', [1, 2, 2]);
  assert.equal(res.ok, true);
  const [call] = s.controllers.beta.calls;
  assert.equal(call[0], 'makePlan');
  assert.deepEqual(call[1], { projectId: 'beta', repoPath: '/repo/beta', profileId: 'claude', env: { PATH: 'x' }, todoAts: [1, 2], plannerEffort: 'high' });
  assert.deepEqual(s.out.sent.at(-1), ['orchestra:changed', { projectId: 'beta', view: res.plan }]);
  // An off-shape selection fails closed to "none picked".
  await s.invoke('orchestra:plan', 'tab-a', ['1', 2]);
  assert.deepEqual(s.controllers.alpha.calls[0][1].todoAts, []);
  await s.invoke('orchestra:plan', 'tab-a', [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.controllers.alpha.calls[1][1].todoAts, [], 'more than the list can hold');
});

test('an explicit projectId null addresses the run of a tab with no project, never the fallback', async (t) => {
  const s = setup({ runs: { alpha: view('pa') }, active: 'alpha' });
  t.after(s.cleanup);
  assert.equal(await s.invoke('orchestra:kill', { projectId: null }), false, 'no such run yet: nothing is killed');
  assert.deepEqual(calledNames(s.controllers.alpha), [], "the active tab's run is not hit instead");
  const none = s.registry.ensure(null);
  none.state.view = view('pn');
  assert.equal(await s.invoke('orchestra:kill', { projectId: null }), true);
  assert.deepEqual(calledNames(none), ['kill']);
  assert.equal((await s.invoke('orchestra:launch', { projectId: null, planId: 'pn' })).ok, true);
  assert.deepEqual(await s.invoke('orchestra:launch', { projectId: null, planId: 'pa' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(calledNames(s.controllers.alpha), []);
  // A missing projectId still falls back as before.
  assert.equal((await s.invoke('orchestra:get', {})).id, 'pa');
});

test('orchestra:plan passes a valid planner effort, anything else falls back to high', async (t) => {
  const s = setup({ runs: {} });
  t.after(s.cleanup);
  const sent = ['xhigh', 'max', 'medium', undefined, null, 'low', 'HIGH', 'max --dangerously-skip-permissions', 5, { effort: 'max' }];
  for (const effort of sent) await s.invoke('orchestra:plan', 'tab-a', null, effort);
  const got = s.controllers.alpha.calls.filter((c) => c[0] === 'makePlan').map((c) => c[1].plannerEffort);
  assert.deepEqual(got, ['xhigh', 'max', 'medium', 'high', 'high', 'high', 'high', 'high', 'high', 'high']);
});

test('orchestra:plan refuses an oversized selection before walking it', async (t) => {
  const s = setup({ runs: {} });
  t.after(s.cleanup);
  const huge = new Array(1e6).fill(1);
  await s.invoke('orchestra:plan', 'tab-a', huge);
  assert.deepEqual(s.controllers.alpha.calls[0][1].todoAts, []);
});

test('allow reports why the run could not be resolved', async (t) => {
  const s = setup({ runs: { alpha: view('pa') } });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:allow', 'Bash(npm test:*)', { projectId: 'ghost' }), { ok: false, error: 'unknownProject' });
  assert.deepEqual(await s.invoke('orchestra:allow', 'Bash(npm test:*)', 'alpha'), { ok: false, error: 'badPayload' });
});

test('orchestra:plan refuses a tab whose folder is gone', async (t) => {
  const s = setup({ runs: {} });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:plan', 'tab-norepo', null), { ok: false, error: 'noRepo' });
  assert.equal(s.registry.get('gamma'), null);
});

test("Luna's Work on a project blocks that project's run only", async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') }, blocked: ['alpha'] });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 'alpha' }), { ok: false, error: 'lunasWorkActive' });
  assert.deepEqual(await s.invoke('orchestra:launch', { planId: 'pa' }), { ok: false, error: 'lunasWorkActive' });
  assert.deepEqual(await s.invoke('orchestra:discard', { projectId: 'beta' }), { ok: true });
  assert.equal(await s.invoke('orchestra:kill', { projectId: 'alpha' }), true, 'Kill always works');
});

test('orchestra:list summarizes every run without prompts or folders', async (t) => {
  const s = setup({ runs: { alpha: view('pa', { pausedUntil: 99 }), beta: null } });
  t.after(s.cleanup);
  const list = await s.invoke('orchestra:list');
  assert.deepEqual(list, [
    {
      projectId: 'alpha',
      label: 'Alpha',
      planId: 'pa',
      started: true,
      killed: false,
      settled: false,
      running: false,
      pausedUntil: 99,
      interrupted: false,
      scheduledAt: null,
      tally: { done: 1 },
      packages: 1,
      integration: null,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(list), /secret prompt|\/repo\//);
  assert.equal(runSummary({ projectId: null, view: { id: 'x' }, running: true }, []).label, null);
});

test('resume after shutdown: payloads are validated in main, the plan id cross-checked', async (t) => {
  const s = setup({ runs: { alpha: view('pa', { interrupted: { by: 'shutdown' } }), beta: view('pb') } });
  t.after(s.cleanup);
  const channels = ['orchestra:resumeInterrupted', 'orchestra:cancelResume', 'orchestra:pauseForShutdown'];
  for (const channel of channels) {
    for (const junk of [null, 'pa', 42, ['pa'], {}, { planId: 7 }, { planId: '../x' }, { planId: 'pa', projectId: 3 }]) {
      assert.deepEqual(await s.invoke(channel, junk), { ok: false, error: 'badPayload' }, `${channel} ${JSON.stringify(junk)}`);
    }
    assert.deepEqual(await s.invoke(channel, { planId: 'pb', projectId: 'alpha' }), { ok: false, error: 'noPlan' }, 'plan of another run');
    assert.deepEqual(await s.invoke(channel, { planId: 'pa', projectId: 'ghost' }), { ok: false, error: 'unknownProject' });
  }
  assert.deepEqual(calledNames(s.controllers.alpha), [], 'nothing reached the controller');

  assert.deepEqual(await s.invoke('orchestra:resumeInterrupted', { planId: 'pa', extra: 'x' }), { ok: true });
  assert.deepEqual(s.controllers.alpha.calls.at(-1), ['resumeInterrupted', { planId: 'pa' }], 'only the plan id is passed on');
  assert.deepEqual(await s.invoke('orchestra:cancelResume', { planId: 'pa', projectId: 'alpha' }), { ok: true });
  assert.deepEqual(await s.invoke('orchestra:pauseForShutdown', { planId: 'pb' }), { ok: true });
  assert.deepEqual(s.controllers.beta.calls.at(-1), ['pauseForShutdown', { planId: 'pb' }]);
  assert.ok(s.out.sent.some(([channel, p]) => channel === 'orchestra:changed' && p.projectId === 'alpha'), 'board refreshed');
});

test("resume after shutdown: Luna's Work blocks Resume now and Pause, never Cancel", async (t) => {
  const s = setup({ runs: { alpha: view('pa') }, blocked: ['alpha'] });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:resumeInterrupted', { planId: 'pa' }), { ok: false, error: 'lunasWorkActive' });
  assert.deepEqual(await s.invoke('orchestra:pauseForShutdown', { planId: 'pa' }), { ok: false, error: 'lunasWorkActive' });
  assert.deepEqual(await s.invoke('orchestra:cancelResume', { planId: 'pa' }), { ok: true });
  assert.deepEqual(calledNames(s.controllers.alpha), ['cancelResume']);
});

test("openPr opens only the resolved run's own, shape-checked PR URL", async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb', { packages: [{ id: 'a', prUrl: 'javascript:alert(1)' }] }) } });
  t.after(s.cleanup);
  s.emit('orchestra:openPr', 'a', { projectId: 'beta' });
  s.emit('orchestra:openPr', 'a', { projectId: 'ghost' });
  s.emit('orchestra:openPr', 'a', 'alpha');
  s.emit('orchestra:openPr', { id: 'a' }, { projectId: 'alpha' });
  assert.deepEqual(s.out.external, []);
  s.emit('orchestra:openPr', 'a', { projectId: 'alpha' });
  assert.deepEqual(s.out.external, [PR_URL]);
});

test("openReport opens the run's own report file and nothing else", async (t) => {
  const s = setup({ runs: { alpha: view('pa') } });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:openReport', 'pa'), { ok: false, error: 'noReport' });
  fs.writeFileSync(path.join(s.runsDir, 'pa.md'), '# report');
  assert.deepEqual(await s.invoke('orchestra:openReport', 'pa', { projectId: 'alpha' }), { ok: true });
  assert.deepEqual(s.out.opened, [path.join(s.runsDir, 'pa.md')]);
});

test('allow accepts only a rule the resolved run logged, and keeps the list unique', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb', { suggestions: [] }) } });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:allow', 'Bash(npm test:*)', { projectId: 'beta' }), { ok: false, error: 'badRule' });
  assert.deepEqual(await s.invoke('orchestra:allow', 'Bash(npm test:*)', { projectId: 'alpha' }), { ok: true, allowed: ['Bash(npm test:*)'] });
  assert.deepEqual((await s.invoke('orchestra:allow', 'Bash(npm test:*)', { projectId: 'alpha' })).allowed, ['Bash(npm test:*)']);
});

test('power and options calls reach the resolved run', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  await s.invoke('orchestra:cancel-power', 'sleep', { projectId: 'beta' });
  await s.invoke('orchestra:cancel-power', 'shutdown', { projectId: 'beta' });
  await s.invoke('orchestra:check-wake', { projectId: 'beta' });
  await s.invoke('orchestra:set-options', { sleepOnLimit: true }, { projectId: 'beta' });
  await s.invoke('orchestra:cancelPlanWait', { projectId: 'beta' });
  assert.deepEqual(calledNames(s.controllers.beta), ['cancelSleep', 'cancelShutdown', 'checkWake', 'setOptions', 'cancelPlanWait']);
  assert.deepEqual(calledNames(s.controllers.alpha), []);
  assert.deepEqual(await s.invoke('orchestra:check-wake', { projectId: 'ghost' }), { ok: false, reason: 'noRun' });
});

test('every orchestra channel the preload bridge calls has a handler in main', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const used = new Set([...preload.matchAll(/'(orchestra:[A-Za-z:-]+)'/g)].map((m) => m[1]));
  // Pushed from main to the page, not handled.
  const pushed = new Set(['orchestra:changed', 'orchestra:planWait']);
  assert.ok(used.has('orchestra:list'));
  assert.ok(used.has('orchestra:planRun:start'));
  assert.ok(used.has('orchestra:planRun:openDoc'));
  for (const channel of used) {
    const handled = s.handlers.has(channel) || s.listeners.has(channel);
    assert.ok(handled || pushed.has(channel), `${channel} has a handler`);
  }
});

// ---- Abort finish + why Retry was refused ---------------------------------------

test('orchestra:abortFinalize: bad payloads and a wrong project are refused, the right run is aborted', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  for (const junk of [null, undefined, 'pa', ['pa'], 5, {}, { planId: 42 }, { planId: '' }, { planId: ['pa'] }]) {
    assert.deepEqual(await s.invoke('orchestra:abortFinalize', junk), { ok: false, error: 'badPayload' }, JSON.stringify(junk));
  }
  assert.deepEqual(await s.invoke('orchestra:abortFinalize', { projectId: 'ghost', planId: 'pa' }), { ok: false, error: 'unknownProject' });
  assert.deepEqual(await s.invoke('orchestra:abortFinalize', { projectId: 7, planId: 'pa' }), { ok: false, error: 'badProject' });
  // alpha's plan named under beta: refused, neither run touched.
  assert.deepEqual(await s.invoke('orchestra:abortFinalize', { projectId: 'beta', planId: 'pa' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(await s.invoke('orchestra:abortFinalize', { planId: 'zzz' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(calledNames(s.controllers.alpha), []);
  assert.deepEqual(calledNames(s.controllers.beta), []);

  // Only the plan id crosses to the controller - nothing else from the page.
  const res = await s.invoke('orchestra:abortFinalize', { projectId: 'beta', planId: 'pb', error: 'rm -rf', force: true });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(s.controllers.beta.calls, [['abortFinalize', { planId: 'pb' }]]);
  assert.deepEqual(calledNames(s.controllers.alpha), [], "the other project's finish is untouched");
  assert.deepEqual(s.out.sent, [['orchestra:changed', { projectId: 'beta', view: view('pb') }]]);
});

test("orchestra:abortFinalize passes the controller's own refusal through and pushes no view", async (t) => {
  const s = setup({ runs: { alpha: view('pa') } });
  t.after(s.cleanup);
  s.controllers.alpha.abortFinalize = () => ({ ok: false, error: 'tooEarly' });
  assert.deepEqual(await s.invoke('orchestra:abortFinalize', { planId: 'pa' }), { ok: false, error: 'tooEarly' });
  assert.deepEqual(s.out.sent, []);
});

test('the preload bridge sends only the plan id (and scope) for Abort finish', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(
    preload,
    /abortOrchestraFinalize: \(planId, projectId\) =>\s+ipcRenderer\.invoke\('orchestra:abortFinalize', withProject\(\{ planId: typeof planId === 'string' \? planId : null \}, projectId\)\)/,
  );
});

/** pl and en blocks of src/renderer/i18n.js, as source text. */
function i18nBlocks() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  return { pl: src.slice(0, enAt), en: src.slice(enAt) };
}

/** The value of `key` in one block, or null. */
function entry(block, key) {
  const line = block.split('\n').find((l) => l.includes(`'${key}':`));
  if (!line) return null;
  const m = /:\s*(['"])(.*)\1,\s*$/.exec(line);
  return m ? m[2] : null;
}

test('every Retry refusal code maps to its own pl and en message, shown beside the package', async () => {
  const { retryRefusal, RETRY_REFUSALS } = await import('../src/renderer/modules/orchestraRetry.js');
  const { pl, en } = i18nBlocks();
  const idle = { integration: { running: false } };
  const seen = new Set();
  for (const code of ['busy', 'paused', 'notRetryable', 'noTab', 'briefFailed']) {
    assert.ok(RETRY_REFUSALS.includes(code), code);
    const { key } = retryRefusal(code, idle);
    assert.equal(key, `orch.retryRefused.${code}`);
    seen.add(key);
    assert.ok(entry(pl, key), `pl ${key}`);
    assert.ok(entry(en, key), `en ${key}`);
    assert.notEqual(entry(en, key), entry(en, 'orch.retryRefused.failed'), `${code} has its own text`);
  }
  assert.equal(seen.size, 5, 'one message per code');
  assert.equal(retryRefusal('somethingNew', idle).key, 'orch.retryRefused.failed');
  assert.equal(retryRefusal(undefined, null).key, 'orch.retryRefused.failed');
});

test("Retry refused as 'busy' while the run finishes names the time it started", async () => {
  const { retryRefusal } = await import('../src/renderer/modules/orchestraRetry.js');
  const at = Date.UTC(2026, 10, 5, 2, 40);
  assert.deepEqual(retryRefusal('busy', { integration: { running: true, startedAt: at } }), {
    key: 'orch.retryRefused.busyFinishing',
    at,
  });
  // Busy with something else (planning / launching): the plain message.
  assert.equal(retryRefusal('busy', { integration: { running: false, startedAt: at } }).key, 'orch.retryRefused.busy');
  const { pl, en } = i18nBlocks();
  assert.equal(entry(en, 'orch.retryRefused.busyFinishing'), 'Finishing the run (merge + tests) since {time} - Retry waits for it.');
  assert.match(entry(pl, 'orch.retryRefused.busyFinishing'), /\{time\}/);
});

test('a stale refusal goes once what was in the way is gone', async () => {
  const { refusalStillValid } = await import('../src/renderer/modules/orchestraRetry.js');
  assert.equal(refusalStillValid('busy', { integration: { running: true } }), true);
  assert.equal(refusalStillValid('busy', { integration: { running: false } }), false);
  // A 'busy' from planning / launching (not the finish) stays until the next Retry.
  assert.equal(refusalStillValid('busy', { integration: { running: false } }, false), true);
  assert.equal(refusalStillValid('paused', { pausedUntil: 5 }), true);
  assert.equal(refusalStillValid('paused', { pausedUntil: null }), false);
  assert.equal(refusalStillValid('batteryLow', { battery: { held: true } }), true);
  assert.equal(refusalStillValid('batteryLow', { battery: { held: false } }), false);
  assert.equal(refusalStillValid('noTab', {}), true);
  assert.equal(refusalStillValid('noTab', null), false);
});

test('a finish past the threshold exposes Abort finish; before it, or once done, it does not', async () => {
  const { canAbortFinish } = await import('../src/renderer/modules/orchestraRetry.js');
  const { ABORT_FINISH_AFTER_MS } = require('../src/orchestraFinalize.js');
  assert.equal(ABORT_FINISH_AFTER_MS, 30 * 60 * 1000);
  const startedAt = 1_000_000;
  const plan = { integration: { running: true, startedAt, abortAfter: startedAt + ABORT_FINISH_AFTER_MS } };
  assert.equal(canAbortFinish(plan, startedAt + ABORT_FINISH_AFTER_MS - 1), false);
  assert.equal(canAbortFinish(plan, startedAt + ABORT_FINISH_AFTER_MS), true);
  assert.equal(canAbortFinish({ integration: { ...plan.integration, running: false } }, startedAt * 10), false);
  assert.equal(canAbortFinish({ integration: { running: true, abortAfter: null } }, startedAt * 10), false);
  assert.equal(canAbortFinish(null, startedAt * 10), false);
});

test('every new board string has pl (without diacritics) and en', () => {
  const { pl, en } = i18nBlocks();
  const keys = [
    'orch.retryRefused.busy',
    'orch.retryRefused.busyFinishing',
    'orch.retryRefused.paused',
    'orch.retryRefused.notRetryable',
    'orch.retryRefused.noTab',
    'orch.retryRefused.briefFailed',
    'orch.retryRefused.batteryLow',
    'orch.retryRefused.failed',
    'orch.abortFinish',
    'orch.abortFinish.hint',
    'orch.fail.batteryLow',
    'orch.fail.notFinishing',
    'orch.fail.tooEarly',
    'orch.fail.notAbortable',
    'orch.integerr.abortedByUser',
    'orch.battery.on',
    'orch.battery.pct',
    'orch.battery.held',
  ];
  for (const key of keys) {
    const p = entry(pl, key);
    assert.ok(p, `pl ${key}`);
    assert.ok(entry(en, key), `en ${key}`);
    assert.doesNotMatch(p, /[^\x00-\x7f]/, `pl ${key} without diacritics`);
    assert.notEqual(p, entry(en, key), `${key} is translated`);
  }
});

test('resend email: the board projectId must own the run; no projectId resends by id', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  fs.writeFileSync(path.join(s.runsDir, 'pa.md'), '# report');
  assert.deepEqual(await s.invoke('orchestra:resend-email', 'pa', { projectId: 'beta' }), { ok: false, reason: 'unknownRun' });
  assert.deepEqual(await s.invoke('orchestra:resend-email', 'pa', { projectId: 7 }), { ok: false, reason: 'unknownRun' });
  assert.deepEqual(await s.invoke('orchestra:resend-email', 'pa', 'alpha'), { ok: false, reason: 'unknownRun' });
  assert.deepEqual(s.out.resent, []);
  assert.deepEqual(await s.invoke('orchestra:resend-email', 'pa', { projectId: 'alpha' }), { ok: true });
  assert.deepEqual(s.out.resent, ['pa']);
});

test('release now asks for the asking project\'s own run', async (t) => {
  const s = setup({ runs: { alpha: view('pa'), beta: view('pb') } });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:release-now', 'beta'), { ok: false, reason: 'noRun' });
  assert.deepEqual(s.out.releaseAsked, ['beta']);
});
