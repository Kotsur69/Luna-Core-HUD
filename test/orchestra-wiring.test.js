// ============================================================================
// God Mode v2 wiring (src/orchestraWiring.js, docs/tbc_docs/MULTI_GODMODE_PLAN.md A2):
// one controller's deps are bound to its project - the stored run file, the
// renderer events and the cross-run guards all name that project, and Luna's
// Work sees one run per project through godModeFacade. No Electron, no IO
// beyond what the fakes record. Power methods are never called here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { makeOrchestraDeps, godModeFacade, legacyRunProject } = require('../src/orchestraWiring.js');

/** The ctx main.js hands over, faked; `out` records what the deps did. */
function fakeCtx(overrides = {}) {
  const out = { sent: [], saved: [], builderChanges: [], errors: [], asked: [] };
  const stored = new Map();
  const registry = {
    get: () => null,
    othersActive: (projectId) => {
      out.asked.push(['othersActive', projectId]);
      return true;
    },
    repoBusy: (projectId, repo) => {
      out.asked.push(['repoBusy', projectId, repo]);
      return false;
    },
  };
  const ctx = {
    registry: () => registry,
    builder: {
      isBuilding: () => false,
      wrapPlanner: (fn) => fn,
      workerSettings: (base) => base,
      ownsMerge: () => false,
      onChange: (view, projectId) => out.builderChanges.push([view, projectId]),
    },
    secretGate: { wrapSelfCheck: (fn) => fn, wrapPushBranch: (fn) => fn },
    overnight: { suspendAwake: () => {}, restoreAwake: () => {}, startRun: () => {} },
    sessions: new Map(),
    send: (channel, payload) => out.sent.push([channel, payload]),
    readUiPrefs: () => ({}),
    readTodos: () => [],
    writeTodos: () => true,
    createSession: () => null,
    closeSession: () => {},
    usageResetAt: () => null,
    toolEnv: () => ({}),
    userDir: () => path.join(path.sep, 'cfg'),
    ensureUserDir: () => true,
    runsDir: () => path.join(path.sep, 'cfg', 'runs'),
    worktrees: {},
    putSnapshot: () => {},
    onReport: () => {},
    onLive: () => {},
    messageBox: () => null,
    toast: () => {},
    projects: () => [{ id: 'alpha', path: path.resolve('/repo/alpha') }],
    resolveStoredPath: (p) => p,
    flushTodos: () => {},
    usageLimits: () => [],
    accountFailover: () => false,
    freeProfileId: () => null,
    playCue: () => {},
    log: () => {},
    logError: (line) => out.errors.push(line),
    store: {
      loadRun: (projectId) => stored.get(projectId) || null,
      saveRun: (projectId, data) => {
        out.saved.push([projectId, data]);
        if (data === null) stored.delete(projectId);
        else stored.set(projectId, data);
        return true;
      },
    },
    ...overrides,
  };
  return { ctx, out, stored, registry };
}

test('saveState writes the bound project file, and a discard (null) clears that same one', () => {
  const { ctx, out } = fakeCtx();
  const deps = makeOrchestraDeps('alpha', ctx);
  deps.saveState({ id: 'p1', projectId: 'alpha' });
  deps.saveState(null);
  assert.deepEqual(out.saved, [
    ['alpha', { id: 'p1', projectId: 'alpha' }],
    ['alpha', null],
  ]);
});

test('a failed save is logged, not thrown', () => {
  const { ctx, out } = fakeCtx();
  ctx.store = { loadRun: () => null, saveRun: () => false };
  makeOrchestraDeps('alpha', ctx).saveState({ id: 'p1' });
  assert.equal(out.errors.length, 1);
});

test("loadState returns only the bound project's run, and only for a registered folder that no other run holds", () => {
  const { ctx, stored, out, registry } = fakeCtx();
  const deps = makeOrchestraDeps('alpha', ctx);
  assert.equal(deps.loadState(), null, 'nothing stored');
  stored.set('alpha', { id: 'p1', repoPath: path.resolve('/repo/alpha') });
  assert.equal(deps.loadState().id, 'p1');
  assert.deepEqual(out.asked.at(-1), ['repoBusy', 'alpha', path.resolve('/repo/alpha')]);
  stored.set('alpha', { id: 'p2', repoPath: path.resolve('/somewhere/else') });
  assert.equal(deps.loadState(), null, 'not a registered project folder');
  stored.set('alpha', { id: 'p3', repoPath: path.resolve('/repo/alpha') });
  registry.repoBusy = () => true;
  assert.equal(deps.loadState(), null, 'another project holds the repo');
  assert.equal(out.errors.length, 1);
});

test('renderer events carry the bound project; the builder hears which project changed', () => {
  const { ctx, out } = fakeCtx();
  const deps = makeOrchestraDeps('beta', ctx);
  deps.onChange({ id: 'p9' });
  deps.onChange(null);
  deps.onPlanWait({ state: 'armed' });
  assert.deepEqual(out.sent, [
    ['orchestra:changed', { projectId: 'beta', view: { id: 'p9' } }],
    ['orchestra:changed', { projectId: 'beta', view: null }],
    ['orchestra:planWait', { projectId: 'beta', state: { state: 'armed' } }],
  ]);
  assert.deepEqual(out.builderChanges, [
    [{ id: 'p9' }, 'beta'],
    [null, 'beta'],
  ]);
});

test('otherRunsActive and repoBusy ask the registry about this project', () => {
  const { ctx, out } = fakeCtx();
  const deps = makeOrchestraDeps('beta', ctx);
  assert.equal(deps.otherRunsActive(), true);
  assert.equal(deps.repoBusy('/r'), false);
  assert.deepEqual(out.asked, [
    ['othersActive', 'beta'],
    ['repoBusy', 'beta', '/r'],
  ]);
});

test("Luna's Work overlays apply only while it builds on this controller's project", async () => {
  const building = new Set(['alpha']);
  const { ctx } = fakeCtx({
    builder: {
      isBuilding: (projectId) => building.has(projectId),
      wrapPlanner: () => async () => ({ ok: true, wrapped: true }),
      workerSettings: (base) => ({ ...base, model: 'plan' }),
      ownsMerge: () => false,
      onChange: () => {},
    },
    readUiPrefs: () => ({ orchestraWorkerModel: 'opus' }),
  });
  const alpha = makeOrchestraDeps('alpha', ctx);
  const beta = makeOrchestraDeps('beta', ctx);
  assert.equal(alpha.workerSettings().model, 'plan');
  assert.equal(beta.workerSettings().model, 'opus', "another project's run is plain God Mode");
  assert.equal((await alpha.runPlanner({})).wrapped, true);
});

test("godModeFacade: Luna's Work sees each project's own run, and plan calls go to the run that owns the plan", async () => {
  const runs = {
    alpha: { view: () => ({ id: 'pa' }), planWait: () => null, cancelPlanWait: () => 'cancelled-a', launch: async () => 'launched-a', makePlan: async (c) => `planned-${c.projectId}` },
  };
  const registry = {
    get: (id) => runs[id] || null,
    ensure: (id) => runs[id] || (runs[id] = { makePlan: async (c) => `planned-${c.projectId}` }),
    byPlanId: (planId) => (planId === 'pa' ? { projectId: 'alpha', controller: runs.alpha } : null),
  };
  const facade = godModeFacade(() => registry);
  assert.deepEqual(facade.view('alpha'), { id: 'pa' });
  assert.equal(facade.view('beta'), null);
  assert.equal(facade.planWait('beta'), null);
  assert.equal(facade.cancelPlanWait('alpha'), 'cancelled-a');
  assert.equal(facade.cancelPlanWait('beta'), null);
  assert.equal(await facade.launch({ planId: 'pa' }), 'launched-a');
  assert.deepEqual(await facade.launch({ planId: 'nope' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(await facade.finishRun(null), { ok: false, error: 'noPlan' });
  assert.equal(await facade.makePlan({ projectId: 'gamma' }), 'planned-gamma');
});

test("legacyRunProject matches a legacy run's repoPath against the registered projects", () => {
  const { ctx } = fakeCtx();
  assert.equal(legacyRunProject(ctx, { repoPath: path.resolve('/repo/alpha') }), 'alpha');
  assert.equal(legacyRunProject(ctx, { repoPath: path.resolve('/repo/none') }), null);
  assert.equal(legacyRunProject(ctx, {}), null);
  assert.equal(legacyRunProject(ctx, null), null);
});

test('sharedPowerDeps: one flow for every run - a change re-sends every run view; makeOrchestraDeps hands the shared flow over', (t) => {
  const fs = require('fs');
  const { sharedPowerDeps } = require('../src/orchestraWiring.js');
  const written = [];
  t.mock.method(fs, 'appendFileSync', (file, text) => written.push([file, text]));
  const { ctx, out, registry } = fakeCtx();
  registry.views = () => [
    { projectId: 'alpha', view: { id: 'p1' } },
    { projectId: 'beta', view: { id: 'p2' } },
  ];
  const shared = sharedPowerDeps(ctx);
  assert.equal(typeof shared.power.scheduleWake, 'function');
  shared.onChange();
  assert.deepEqual(out.sent, [
    ['orchestra:changed', { projectId: 'alpha', view: { id: 'p1' } }],
    ['orchestra:changed', { projectId: 'beta', view: { id: 'p2' } }],
  ]);
  shared.appendReport('../evil', 'x');
  shared.appendReport(null, 'x');
  assert.deepEqual(written, [], 'a junk plan id is never a file name');
  shared.appendReport('p1', '- PC shut down at 07:00');
  assert.deepEqual(written, [[path.join(path.sep, 'cfg', 'runs', 'p1.md'), '- PC shut down at 07:00\n']]);
  assert.deepEqual(out.errors, []);
  const flow = { view: () => null };
  assert.equal(makeOrchestraDeps('alpha', ctx, { powerFlow: flow }).powerFlow, flow);
  assert.equal('powerFlow' in makeOrchestraDeps('alpha', ctx), false, 'no shared flow: the controller builds its own');
});

// ---- memory capture of a finished run (src/memoryruncapture.js) ---------------------

/** A ctx whose registry hands out one controller with this view and repo. */
function reportCtx(view, overrides = {}) {
  const { ctx, out } = fakeCtx(overrides);
  const controller = { view: () => view, repoPath: () => path.resolve('/repo/alpha') };
  ctx.registry = () => ({ get: () => controller, othersActive: () => false, repoBusy: () => false });
  return { ctx, out };
}

test('a written report hands the run to onRunReport once, and the email still gets its answer', () => {
  const runs = [];
  const view = { id: 'p1', packages: [] };
  const { ctx, out } = reportCtx(view, { onReport: () => 'mail-result', onRunReport: (run) => runs.push(run) });
  const res = makeOrchestraDeps('alpha', ctx).onReport('p1', '# report', {});
  assert.equal(res, 'mail-result');
  assert.deepEqual(runs, [{ runId: 'p1', repoPath: path.resolve('/repo/alpha'), view }]);
  assert.deepEqual(out.errors, []);
});

test('run capture cannot break the report: a throw or a rejection is only logged', async () => {
  const throwing = reportCtx({ id: 'p1' }, { onReport: () => 'ok', onRunReport: () => { throw new Error('boom'); } });
  assert.equal(makeOrchestraDeps('alpha', throwing.ctx).onReport('p1', '', {}), 'ok');
  assert.match(throwing.out.errors[0], /run capture failed: boom/);

  const rejecting = reportCtx({ id: 'p1' }, { onReport: () => 'ok', onRunReport: () => Promise.reject(new Error('late')) });
  assert.equal(makeOrchestraDeps('alpha', rejecting.ctx).onReport('p1', '', {}), 'ok');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(rejecting.out.errors[0], /run capture failed: late/);
});

test('a report for a run that is no longer on the board is not captured', () => {
  const runs = [];
  const { ctx } = reportCtx({ id: 'p2' }, { onRunReport: (run) => runs.push(run) });
  makeOrchestraDeps('alpha', ctx).onReport('p1', '', {});
  assert.deepEqual(runs, []);
});
