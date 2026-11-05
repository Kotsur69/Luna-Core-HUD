// ============================================================================
// God Mode end of run (orchestraFinalize.js) surviving a PC sleep: the
// integrate watchdog, abort / interrupt on a system resume, a stored
// 'running' integration after a restart - and Retry is never refused 'busy'
// afterwards.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra } = require('../src/orchestra.js');
const { createFinalizer, integrateTimeoutFor, INTEGRATE_BASE_MS, INTEGRATE_PER_PACKAGE_MS } = require('../src/orchestraFinalize.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
/** Polls until `cond()` holds (real timers settle the watchdog / drain), max ~3 s. */
async function until(cond) {
  for (let i = 0; i < 300 && !cond(); i += 1) await wait(10);
}

// ---- the finalizer alone ---------------------------------------------------------

function finalizerFor({ integrateMerge, timeoutMs = 30, scope = null, onAbort, drainMs = 5 } = {}) {
  const plan = {
    id: 'run1',
    repoPath: '/r',
    baseBranch: 'main',
    integrationMode: 'merge',
    integration: { state: 'idle' },
    approvalLog: [],
    packages: [{ id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', dependsOn: [] }],
  };
  const events = [];
  const commits = [];
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => {
      plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
    },
    commit: () => commits.push({ ...plan.integration }),
    view: () => ({ id: plan.id, packages: plan.packages, integration: plan.integration, overlaps: [] }),
    onRunEvent: (kind, data) => events.push([kind, data]),
    now: () => 1,
    sleep: async () => {},
    integrateMerge,
    integrateTimeoutMs: timeoutMs,
    createScope: scope ? () => scope : undefined,
    onAbort,
    drainMs,
  });
  return { plan, events, commits, fin };
}

function fakeScope() {
  const s = { kills: 0, killAll: async () => ((s.kills += 1), { killed: 2, failed: 0 }) };
  return s;
}

test('the default watchdog is longer than the longest legitimate integrate', () => {
  assert.equal(integrateTimeoutFor({ packages: [] }), INTEGRATE_BASE_MS + INTEGRATE_PER_PACKAGE_MS);
  assert.equal(integrateTimeoutFor({ packages: [1, 2, 3] }), INTEGRATE_BASE_MS + 3 * INTEGRATE_PER_PACKAGE_MS);
  // install + self-check + fix-up + re-check, and per package verify + both resolver tries.
  assert.ok(INTEGRATE_BASE_MS > (15 + 15 + 3 + 45 + 18) * 60_000);
  assert.ok(INTEGRATE_PER_PACKAGE_MS >= (15 + 15 + 30) * 60_000);
});

test('integrateMerge that never resolves: finalize settles with integrateTimeout and kills the process tree', async () => {
  const scope = fakeScope();
  const f = finalizerFor({ integrateMerge: never, timeoutMs: 20, scope });
  const done = f.fin.finalize();
  assert.equal(f.fin.isRunning(), true);
  assert.equal(await done, true);
  assert.equal(f.fin.isRunning(), false);
  assert.deepEqual([f.plan.integration.state, f.plan.integration.error], ['failed', 'integrateTimeout']);
  assert.equal(scope.kills, 1, 'the children it spawned are killed');
  const aborted = f.events.find(([k]) => k === 'integrationAborted');
  assert.deepEqual(aborted[1], { error: 'integrateTimeout', killed: 2, failed: 0 });
  assert.ok(f.events.some(([k]) => k === 'finalized'));
});

test('a late result of an abandoned integrate does not overwrite the timed-out pass', async () => {
  let release;
  const f = finalizerFor({
    integrateMerge: () => new Promise((r) => (release = r)),
    timeoutMs: 15,
  });
  await f.fin.finalize();
  assert.equal(f.plan.integration.error, 'integrateTimeout');
  release({ ok: true, merged: ['a'], skipped: [] });
  await wait(5);
  assert.deepEqual([f.plan.integration.state, f.plan.integration.error], ['failed', 'integrateTimeout']);
  // A push that really landed late is still recorded: a rerun skips it.
  assert.equal(f.plan.packages[0].merged, true);
});

test('abort() ends the integrate step now; false when nothing integrates', async () => {
  const scope = fakeScope();
  const f = finalizerFor({ integrateMerge: never, timeoutMs: 60_000, scope });
  assert.equal(f.fin.abort(), false, 'idle');
  const done = f.fin.finalize();
  await wait(1);
  assert.equal(f.fin.abort('aborted'), true);
  assert.equal(await done, true);
  assert.deepEqual([f.plan.integration.state, f.plan.integration.error, f.fin.isRunning()], ['failed', 'aborted', false]);
  assert.equal(scope.kills, 1);
  assert.equal(f.fin.abort(), false, 'done');
});

test('interrupt() marks the pass interrupted and finalize runs once more', async () => {
  const answers = [never(), Promise.resolve({ ok: true, merged: ['a'], skipped: [] })];
  let calls = 0;
  const f = finalizerFor({ integrateMerge: () => answers[calls++], timeoutMs: 60_000 });
  const first = f.fin.finalize();
  await wait(1);
  assert.equal(f.fin.interrupt(), true);
  assert.equal(await first, true);
  await wait(5);
  assert.equal(calls, 2, 'one re-run');
  assert.ok(f.commits.some((c) => c.state === 'failed' && c.error === 'interrupted'), 'recorded as interrupted');
  assert.deepEqual([f.plan.integration.state, f.fin.isRunning()], ['done', false]);
  assert.equal(f.plan.packages[0].merged, true);
  assert.equal(f.events.filter(([k]) => k === 'finalized').length, 2);
});

test('an interrupted pass unwinds (its children killed) before the re-run starts; the fix-up tab is stopped', async () => {
  const order = [];
  let unwind;
  // The first pass's git fails as soon as its scope is killed, then it tidies up.
  const scope = {
    killAll: async () => {
      order.push('killed');
      setImmediate(() => unwind());
      return { killed: 1, failed: 0 };
    },
  };
  let calls = 0;
  const f = finalizerFor({
    scope,
    timeoutMs: 60_000,
    drainMs: 5_000,
    onAbort: () => order.push('fixupStopped'),
    integrateMerge: () => {
      calls += 1;
      if (calls === 1) {
        order.push('pass1');
        return new Promise((r) => (unwind = () => (order.push('pass1Unwound'), r({ ok: false, merged: [], skipped: [], stage: 'merge' }))));
      }
      order.push('pass2');
      return Promise.resolve({ ok: true, merged: ['a'], skipped: [] });
    },
  });
  const first = f.fin.finalize();
  await wait(1);
  f.fin.interrupt();
  await first;
  await wait(10);
  assert.deepEqual(order, ['pass1', 'killed', 'fixupStopped', 'pass1Unwound', 'pass2']);
  assert.equal(f.plan.integration.state, 'done');
});

test('a pass that ignores the kill is waited for only drainMs', async () => {
  const f = finalizerFor({ integrateMerge: never, timeoutMs: 10, drainMs: 20 });
  const t0 = Date.now();
  await f.fin.finalize();
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual([f.plan.integration.error, f.fin.isRunning()], ['integrateTimeout', false]);
});

test('finalize stays one at a time and never throws while guarded', async () => {
  const f = finalizerFor({
    integrateMerge: async () => {
      throw new Error('boom');
    },
  });
  const [a, b] = await Promise.all([f.fin.finalize(), f.fin.finalize()]);
  assert.deepEqual([a, b], [true, false], 'the second call is folded into a re-run');
  await wait(5);
  assert.equal(f.plan.integration.error, 'integrateThrew');
  assert.equal(f.fin.isRunning(), false);
});

// ---- the run controller ------------------------------------------------------------

const pkg = (id, todoAts) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
});

function setup({ integrateMerge, stored = null, integrateTimeoutMs = 60_000 } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], events: [], saved: null, merges: 0 };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1]), pkg('b', [2])], notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions', integration: 'merge', allowedTools: [] }),
    confirmMerge: async () => true,
    integrateMerge: (...args) => {
      log.merges += 1;
      return integrateMerge(...args);
    },
    removeWorktree: async () => ({ ok: true }),
    writeReport: (id) => `/cfg/runs/${id}.md`,
    saveState: (data) => {
      log.saved = JSON.parse(JSON.stringify(data));
    },
    loadState: () => stored,
    onRunEvent: (kind) => log.events.push(kind),
    sleep: async () => {},
    integrateTimeoutMs,
    integrateDrainMs: 5,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  orch.restore();
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const integ = () => orch.view().integration;
  return { orch, log, ctx, flush, alive, integ, advance: (ms) => (clock += ms) };
}

/**
 * `a` pushed, `b`'s tab closed: the run settles and finalize starts its
 * integrate step, which hangs. Retry of `b` is refused 'busy' meanwhile -
 * the bug.
 */
async function hungFinalize(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id, integration: 'merge' });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  s.orch.onSessionClosed('s2');
  await s.flush();
  assert.deepEqual(s.orch.view().packages.map((p) => p.state), ['pushed', 'closed']);
  assert.equal(s.integ().state, 'running');
  assert.equal(s.integ().running, true);
  assert.equal((await s.orch.retry({ planId: plan.id, id: 'b' })).error, 'busy', 'refused while integrating');
  return { ...s, planId: plan.id };
}

test('controller: a hung integrate times out, the finalizer goes idle and Retry works', async () => {
  // The watchdog runs on real timers: leave enough time for hungFinalize's own
  // 'running' check to happen first, even on a loaded machine.
  const s = await hungFinalize({ integrateMerge: never, integrateTimeoutMs: 300 });
  await until(() => !s.orch.isBusy());
  await s.flush();
  assert.deepEqual([s.integ().state, s.integ().error, s.integ().running], ['failed', 'integrateTimeout', false]);
  assert.equal(s.orch.isBusy(), false);
  const res = await s.orch.retry({ planId: s.planId, id: 'b' });
  assert.equal(res.ok, true, `retry: ${res.error}`);
  assert.equal(s.orch.view().packages[1].state, 'launched');
});

test('controller: a system resume during finalize aborts the pass, finalize re-runs once, then Retry works', async () => {
  let n = 0;
  const s = await hungFinalize({
    integrateMerge: () => (++n === 1 ? never() : Promise.resolve({ ok: true, merged: ['a'], skipped: [], headSha: 'x' })),
  });
  s.orch.onSystemResume();
  // The aborted pass's drain window, then the re-run.
  await until(() => s.log.merges === 2 && !s.orch.isBusy());
  await s.flush();
  assert.ok(s.log.events.includes('finalizeInterrupted'));
  assert.ok(s.log.events.includes('integrationAborted'));
  assert.equal(s.log.merges, 2, 'finalize ran once more');
  assert.deepEqual([s.integ().state, s.integ().running], ['done', false]);
  assert.equal(s.orch.view().packages[0].merged, true);
  assert.equal(s.orch.isBusy(), false);
  // Another resume with nothing integrating changes nothing.
  s.orch.onSystemResume();
  await s.flush();
  assert.equal(s.log.merges, 2);
  const res = await s.orch.retry({ planId: s.planId, id: 'b' });
  assert.equal(res.ok, true, `retry: ${res.error}`);
});

test('controller: a stored integration "running" comes back failed "interrupted" and Retry works', async () => {
  const s = await hungFinalize({ integrateMerge: never });
  assert.equal(s.log.saved.integration.state, 'running', 'saved mid-integration');
  const r = setup({ integrateMerge: never, stored: s.log.saved });
  const integ = r.integ();
  assert.deepEqual([integ.state, integ.error, integ.detail, integ.running], ['failed', 'interrupted', null, false]);
  assert.equal(r.orch.isBusy(), false);
  const res = await r.orch.retry({ planId: s.planId, id: 'b' });
  assert.equal(res.ok, true, `retry: ${res.error}`);
  // Leave the first controller's hung pass behind cleanly.
  s.orch.onSystemResume();
});

test('normalizeStoredPlan: only a stored "running" integration becomes interrupted', () => {
  const base = { id: 'p1', repoPath: path.resolve('/r'), packages: [{ id: 'a' }] };
  const of = (integration) => sup.normalizeStoredPlan({ ...base, integration }).integration;
  assert.deepEqual([of({ state: 'running', error: 'x', detail: 'y' }).state, of({ state: 'running' }).error], ['failed', 'interrupted']);
  assert.equal(of({ state: 'running', detail: 'y' }).detail, null);
  assert.deepEqual([of({ state: 'done' }).state, of({ state: 'failed', error: 'pushFailed' }).error], ['done', 'pushFailed']);
  assert.equal(of({ state: 'nonsense' }).state, 'idle');
  assert.equal(of(undefined).state, 'idle');
});
