// ============================================================================
// A God Mode / Luna's Work worker whose VERY FIRST assistant reply is the
// usage-limit banner (Luna's Work run lwmwzajado, iteration 5: six builders,
// at least two limited on turn one, the build idle for 4 h, then logged as
// 'build green, 0/6 cards landed' with run.limitedUntil never set).
//
// Covers the three halves of the fix:
//   1. src/observer.js: the transcript watcher's first read of a fresh
//      transcript holds the brief AND the limit banner (written within a
//      second); the limit is now reported, so main.js moves the tab to
//      another account (src/claudefailover.js) and resumes its brief.
//   2. src/lunasworkBuild.js: no free account - God Mode pauses the whole run
//      (view.waitingUntil), and the build comes back as a limit, so the
//      controller (src/lunaswork.js limited) knows the retry time; the next
//      build takes the paused run up again instead of planning anew.
//   3. src/lunaswork.js stepBuilding: a settled build that landed nothing
//      because of the limit is reported as limited, never 'build green'.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TranscriptWatcher, usageLimitFrom } = require('../src/observer');
const { createTabFailover } = require('../src/claudefailover');
const { withAccountResume, ACCOUNT_RESUME_MESSAGE } = require('../src/launch');
const { createGodModeBuilder, buildLimitOf } = require('../src/lunasworkBuild');
const { createLunasWork } = require('../src/lunaswork');

const HOUR = 60 * 60 * 1000;
const START_CLOCK = 1_700_000_000_000;
const SESSION_UUID = '9f03213b-5d5f-4ab3-8732-68bec3b6151c';
const REPO = path.resolve(os.tmpdir(), 'lw-first-turn-limit-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-first-turn-limit-runs');

const tick = () => new Promise((r) => setImmediate(r));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- transcript fixtures (the shape Claude Code 2.1 writes, trimmed) --------------

const userPrompt = (at) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'Your task brief is in the file `.luna-brief/x.md` - read it first, then carry it out.' },
  timestamp: new Date(at).toISOString(),
});

const limitBanner = (at) => JSON.stringify({
  type: 'assistant',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  error: 'rate_limit',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 12:50am (Europe/Warsaw)" }],
  },
  timestamp: new Date(at).toISOString(),
});

const limitNotice = (at) => JSON.stringify({
  type: 'system',
  subtype: 'informational',
  content: 'Usage limit reached · set to continue automatically at 12:50am',
  timestamp: new Date(at).toISOString(),
});

function transcriptFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-first-turn-'));
  const file = path.join(dir, `${SESSION_UUID}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file };
}

/** A watcher that started at `startedAt`, as main.js creates one before the CLI runs. */
function watcherFrom(startedAt) {
  const limits = [];
  const drops = [];
  const watcher = new TranscriptWatcher(() => {}, {
    onUsageLimit: (limit) => limits.push(limit),
    onApiError: (drop) => drops.push(drop),
  });
  watcher.startedAt = startedAt;
  return { watcher, limits, drops };
}

// ---- 1. the observer reports a first-turn limit ------------------------------------

test('observer: a limit banner as the very first assistant reply is reported on the first read', () => {
  const started = Date.now() - 5000;
  const { dir, file } = transcriptFile([userPrompt(started + 1000), limitBanner(started + 1600), limitNotice(started + 1602)]);
  try {
    const w = watcherFrom(started);
    w.watcher.accumulate(file);
    assert.equal(w.limits.length, 1, 'the wall is reported');
    assert.ok(Number.isFinite(w.limits[0].resetsAt), 'with the reset time from the banner');
    assert.equal(w.drops.length, 0, 'a limit is never a connection drop');
    // Nothing new appended: no second report.
    w.watcher.accumulate(file);
    assert.equal(w.limits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer: a resumed conversation\'s old banner (before the watcher started) is history', () => {
  const started = Date.now();
  // The account move resumes the same transcript: its first read holds the old wall.
  const { dir, file } = transcriptFile([userPrompt(started - 60_000), limitBanner(started - 59_000)]);
  try {
    const w = watcherFrom(started);
    w.watcher.accumulate(file);
    assert.equal(w.limits.length, 0, 'the old wall does not move the tab again');
    // The resumed turn hits the wall again: live, reported.
    fs.appendFileSync(file, `${userPrompt(started + 500)}\n${limitBanner(started + 900)}\n`);
    w.watcher.accumulate(file);
    assert.equal(w.limits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usageLimitFrom: `since` keeps only entries written at or after it', () => {
  const at = Date.UTC(2026, 10, 27, 19, 52, 11);
  const text = limitBanner(at);
  assert.ok(usageLimitFrom(text, at));
  assert.ok(usageLimitFrom(text, at, at));
  assert.equal(usageLimitFrom(text, at, at + 1), null);
  const undated = JSON.stringify({ ...JSON.parse(text), timestamp: undefined });
  assert.equal(usageLimitFrom(undated, at, at), null, 'an undated entry on a first read is history');
  assert.ok(usageLimitFrom(undated, at), 'without since it counts as before');
});

test('first-turn limit: the worker tab moves to another account and resumes its brief', () => {
  const started = Date.now() - 5000;
  const { dir, file } = transcriptFile([userPrompt(started + 1000), limitBanner(started + 1600)]);
  try {
    const restarted = [];
    const sent = [];
    const limited = [];
    const failover = createTabFailover({
      accounts: {
        markLimited: (id, resetsAt) => {
          limited.push({ id, resetsAt });
          return { from: { label: 'Main' }, switchTo: { id: 'acct-b', label: 'Second' } };
        },
        freeAccount: () => null,
      },
      getProfile: () => ({ command: 'claude', args: [] }),
      withAccountResume,
      restartSession: (session) => restarted.push({ ...session }),
      send: (channel, payload) => sent.push({ channel, payload }),
      defer: (fn) => fn(),
    });
    const task = { model: 'sonnet', permissionMode: 'bypassPermissions', brief: '.luna-brief/x.md' };
    const session = { id: 'tab-1', profileId: 'claude', accountId: 'acct-a', transcriptId: SESSION_UUID, launchTask: task };
    // main.js handleAccountLimit's first step: failoverTab before any pause.
    const watcher = new TranscriptWatcher(() => {}, { onUsageLimit: ({ resetsAt }) => failover.failoverTab(session, resetsAt) });
    watcher.startedAt = started;
    watcher.accumulate(file);

    assert.equal(limited.length, 1);
    assert.equal(limited[0].id, 'acct-a');
    assert.equal(restarted.length, 1, 'the tab restarted');
    assert.equal(restarted[0].resumeId, SESSION_UUID, 'on the same conversation, which holds the brief');
    const command = withAccountResume('claude', restarted[0].resumeId, task);
    assert.match(command, new RegExp(`--resume ${SESSION_UUID}`));
    assert.ok(command.includes(ACCOUNT_RESUME_MESSAGE), 'with the account-move resume text');
    assert.ok(sent.some((s) => s.channel === 'pty:data' && /Continuing on Second/.test(s.payload.data)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 2. the builder: a run waiting on the limit comes back as a limit ---------------

/** God Mode's facade with one plan and a view the test drives. */
function fakeOrchestra() {
  const o = {
    calls: { makePlan: 0, launch: 0 },
    settle: null,
    // No plan until makePlan made one (an open plan before it reads as someone else's).
    view: null,
    makePlan: async (ctx) => {
      o.calls.makePlan += 1;
      o.settle = ctx.onRunSettled;
      o.view = { id: 'p1', projectId: 'game', settled: false, killed: false, waitingUntil: null, packages: [], integration: {} };
      return { ok: true, plan: { id: 'p1', errors: [] } };
    },
    launch: async () => {
      o.calls.launch += 1;
      return { ok: true };
    },
    cancelPlanWait: () => ({ ok: true }),
    viewOf: () => o.view,
  };
  return o;
}

function builderOn(orchestra, clock) {
  return createGodModeBuilder({
    orchestra: {
      // Read at call time, so a test may swap one in.
      makePlan: (ctx) => orchestra.makePlan(ctx),
      launch: (payload) => orchestra.launch(payload),
      cancelPlanWait: () => orchestra.cancelPlanWait(),
      view: () => orchestra.viewOf(),
      planWait: () => null,
    },
    profileId: () => 'claude',
    env: () => ({ PATH: 'x' }),
    isUnityProject: () => false,
    now: () => clock.now,
  });
}

const CARDS = [{ at: 1, text: 'card 1', model: 'sonnet' }, { at: 2, text: 'card 2', model: 'sonnet' }];
const buildOpts = (extra = {}) => ({ projectId: 'game', repoPath: REPO, cards: CARDS, checkCommand: '', ownPlanIds: [], ...extra });
const landed = () => ({
  planId: 'p1',
  killed: false,
  integration: { state: 'done', skipped: [], selfCheck: { tests: 'passed', fixups: 0 } },
  plan: { packages: [{ id: 'pk', merged: true, todos: ['card 1', 'card 2'] }] },
});

test('builder: every worker waiting for the usage reset returns the build as a limit, the run kept', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const builder = builderOn(orchestra, clock);
  const reset = START_CLOCK + 3 * HOUR;
  const building = builder.build(buildOpts());
  await tick();
  assert.equal(orchestra.calls.launch, 1);

  // One worker limited while another still runs: not the whole run, no limit.
  builder.onChange({ ...orchestra.view, waitingUntil: null }, 'game');
  // Every account out: God Mode paused the run until the reset.
  orchestra.view = { ...orchestra.view, waitingUntil: reset, pausedUntil: reset };
  builder.onChange(orchestra.view, 'game');
  const res = await building;
  assert.deepEqual(res, { ok: false, error: 'limit', resumeAt: reset, planId: 'p1' });
  assert.equal(builder.isBuilding('game'), true, 'the paused run keeps the build overlays (merge confirmation)');

  // Another project's build waits for it; the same run's retry before the reset is a limit again.
  assert.deepEqual(await builder.build(buildOpts({ projectId: 'other', resumePlanId: null })), { ok: false, error: 'godModeBusy' });
  assert.equal((await builder.build(buildOpts({ resumePlanId: 'p1' }))).error, 'limit');

  // After the reset God Mode resumed the run: the retry takes it up, no new plan.
  clock.now = reset + 1000;
  orchestra.view = { ...orchestra.view, waitingUntil: null };
  const again = builder.build(buildOpts({ resumePlanId: 'p1' }));
  await tick();
  orchestra.settle(landed());
  const done = await again;
  assert.equal(done.ok, true);
  assert.equal(done.limitedUntil, reset, 'the result says the run waited for a reset');
  assert.equal(orchestra.calls.makePlan, 1, 'never planned again');
  assert.equal(builder.isBuilding(), false);
});

test('builder: a parked run that settles before the retry hands its result to that retry', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const builder = builderOn(orchestra, clock);
  const reset = START_CLOCK + HOUR;
  const building = builder.build(buildOpts());
  await tick();
  orchestra.view = { ...orchestra.view, waitingUntil: reset };
  builder.onChange(orchestra.view, 'game');
  assert.equal((await building).error, 'limit');

  orchestra.settle(landed());
  assert.equal(builder.isBuilding(), false, 'the run is over: no overlay outlives it');
  const res = await builder.build(buildOpts({ resumePlanId: 'p1' }));
  assert.equal(res.ok, true);
  assert.equal(res.planId, 'p1');
  assert.equal(orchestra.calls.makePlan, 1);
});

// ---- 3. buildLimitOf ---------------------------------------------------------------

test('buildLimitOf: nothing merged while the limit wait is still on is a limit; anything else is not', () => {
  const now = START_CLOCK;
  const later = now + HOUR;
  const none = { ok: true, integration: { state: 'done' }, plan: { packages: [{ id: 'a', merged: false }, { id: 'b', merged: false }] } };
  assert.deepEqual(buildLimitOf({ ...none, limitedUntil: later }, now), { error: 'limit', resumeAt: later });
  // The run waited, resumed after the reset and then landed nothing: an ordinary result.
  assert.equal(buildLimitOf({ ...none, limitedUntil: now - 1 }, now), null);
  // Not limited: no limit seen, something merged, a red merge, a kill, nothing to build.
  assert.equal(buildLimitOf(none, now), null);
  assert.equal(buildLimitOf({ ...landed(), ok: true, limitedUntil: later }, now), null);
  assert.equal(buildLimitOf({ ...none, limitedUntil: later, integration: { state: 'failed' } }, now), null);
  assert.equal(buildLimitOf({ ...none, limitedUntil: later, killed: true }, now), null);
  assert.equal(buildLimitOf({ ok: true, nothing: true, integration: { state: 'idle' }, limitedUntil: later }, now), null);
  assert.equal(buildLimitOf({ ok: false, error: 'limit' }, now), null);
});

test('builder: a run that ends right after the limit wake is returned as ended, never parked', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const builder = builderOn(orchestra, clock);
  const building = builder.build(buildOpts());
  await tick();
  orchestra.view = { ...orchestra.view, waitingUntil: START_CLOCK + HOUR };
  // Same tick: the wake, then the run's end, before the build reads the wake.
  builder.onChange(orchestra.view, 'game');
  orchestra.settle(landed());
  const res = await building;
  assert.equal(res.ok, true);
  assert.equal(res.planId, 'p1');
  assert.equal(builder.isBuilding(), false, 'nothing is left active');
});

test('builder: a limit wait committed while launch ran is not missed', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const reset = START_CLOCK + 2 * HOUR;
  const builder = builderOn(orchestra, clock);
  // God Mode paused the run before launch answered: no build listened yet.
  const launch = orchestra.launch;
  orchestra.launch = async (payload) => {
    const res = await launch(payload);
    orchestra.view = { ...orchestra.view, waitingUntil: reset };
    builder.onChange(orchestra.view, 'game');
    return res;
  };
  const res = await builder.build(buildOpts());
  assert.deepEqual(res, { ok: false, error: 'limit', resumeAt: reset, planId: 'p1' });
});

// ---- the controller ----------------------------------------------------------------

const runCard = (at) => ({ at, text: `card ${at}`, done: false, tags: ['run:lwlimit1'], size: 'S' });

/** A Luna's Work controller with fakes; `build` is the test's. */
function controller({ build, settings }) {
  const h = {
    clock: START_CLOCK,
    stored: null,
    timers: [],
    builds: [],
    todos: [runCard(1), runCard(2)],
  };
  const deps = {
    store: { load: () => (h.stored ? clone(h.stored) : null), save: (data) => { h.stored = data === null ? null : clone(data); return true; } },
    settings: () => settings || { models: {}, freeFallback: false, projects: {} },
    projectOf: (id) => (id === 'game' ? { id, repoPath: REPO } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    confirmStart: async () => true,
    todoStore: () => ({ read: () => h.todos, write: (list) => { h.todos = list; return true; } }),
    director: async (o) => (o.iteration > 1
      ? { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' }
      : { ok: true, stop: false, cards: h.todos.filter((t) => !t.done), model: 'opus', modelReason: 'setting', notes: 'n' }),
    build: async (o) => {
      h.builds.push(clone(o));
      return build(o, h);
    },
    createAdapter: (name, o) => ({
      name,
      evidenceDir: path.join(EVIDENCE, `lunaswork-${o.runId}`, `iter-${o.iteration}`),
      start: async () => ({ url: 'http://localhost:3000' }),
      startConsole: () => [],
      stop: async () => true,
      tools: () => ({}),
    }),
    playtest: async (o) => ({
      ok: true, mode: o.mode, model: 'sonnet', modelReason: 'exploratory pass',
      report: { mode: o.mode, findings: [], scores: [{ milestone: 'skeleton', criterion: 'loads', score: 9 }], journeys: [], screens: [] },
    }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({
      ok: true, verdict: 'continue', model: 'sonnet', modelReason: 'regular iteration',
      milestone: { name: 'skeleton', passed: false, score: 50 }, next: 'skeleton', allPassed: false,
    }),
    gitLog: async () => '',
    syncCheckout: async () => ({ ok: true }),
    limitResumeAt: () => null,
    accountFailover: () => false,
    awake: { hold: () => {}, release: () => {} },
    newRunId: () => 'lwlimit1',
    now: () => h.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock + ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => { if (t) t.cleared = true; },
    log: () => {},
  };
  h.ctl = createLunasWork(deps);
  h.settle = async () => {
    for (let i = 0; i < 5; i += 1) await h.ctl.idle();
  };
  h.fire = async () => {
    const t = h.timers.filter((x) => !x.cleared).sort((a, b) => a.at - b.at)[0];
    assert.ok(t, 'a timer is pending');
    t.cleared = true;
    h.clock = Math.max(h.clock, t.at);
    t.fn();
    await h.settle();
  };
  h.log = () => h.ctl.runLog().map((e) => e.text || '').join('\n');
  return h;
}

test('controller: no free account - the run knows its limit and the retry time, not a silent build', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const builder = builderOn(orchestra, clock);
  const reset = START_CLOCK + 3 * HOUR;
  const h = controller({
    build: (o) => {
      const p = builder.build(o);
      // God Mode paused the run once its workers were in: every account out.
      tick().then(() => {
        orchestra.view = { ...orchestra.view, waitingUntil: reset };
        builder.onChange(orchestra.view, 'game');
      });
      return p;
    },
  });
  await h.ctl.start({ projectId: 'game' });
  await h.settle();

  const status = h.ctl.status();
  assert.equal(status.waitReason, 'limit');
  assert.equal(status.waitUntil, reset, 'the board shows the retry time');
  assert.equal(h.stored.waitUntil, reset, 'persisted');
  assert.match(h.log(), /usage limit \(builder\): waiting until/);
  assert.doesNotMatch(h.log(), /build green/);
});

test('controller: freeFallback on - a limited build sets run.limitedUntil', async () => {
  const reset = START_CLOCK + 2 * HOUR;
  const h = controller({
    settings: { models: {}, freeFallback: true, projects: {} },
    // Both builds find the parked run waiting for the reset (lunasworkBuild resumeParked).
    build: () => ({ ok: false, error: 'limit', resumeAt: reset, planId: 'p1' }),
  });
  await h.ctl.start({ projectId: 'game' });
  await h.settle();
  assert.equal(h.stored.limitedUntil, reset);
  assert.deepEqual(h.builds.map((b) => b.free), [false, true]);
  assert.equal(h.ctl.status().waitReason, 'limit', 'the free retry found the run still waiting: no retry loop');
  assert.equal(h.ctl.status().waitUntil, reset);
});

test('controller: a parked build is taken up after the reset and lands its cards', async () => {
  const clock = { now: START_CLOCK };
  const orchestra = fakeOrchestra();
  const builder = builderOn(orchestra, clock);
  const reset = START_CLOCK + 3 * HOUR;
  const h = controller({
    build: (o, hh) => {
      const p = builder.build(o);
      if (hh.builds.length === 1) {
        tick().then(() => {
          orchestra.view = { ...orchestra.view, waitingUntil: reset };
          builder.onChange(orchestra.view, 'game');
        });
      } else {
        tick().then(() => {
          hh.todos = hh.todos.map((t) => ({ ...t, done: true }));
          orchestra.settle(landed());
        });
      }
      return p;
    },
  });
  await h.ctl.start({ projectId: 'game' });
  await h.settle();
  assert.equal(h.ctl.status().waitUntil, reset);

  clock.now = reset;
  orchestra.view = { ...orchestra.view, waitingUntil: null };
  await h.fire();
  assert.equal(h.builds.length, 2);
  assert.equal(h.builds[1].resumePlanId, 'p1', 'the retry names the paused plan');
  assert.equal(orchestra.calls.makePlan, 1, 'the paused run was taken up, not planned again');
  assert.match(h.log(), /build green, 2\/2 cards landed/);
});

test('controller: every builder limited - no "build green, 0/N cards landed", the iteration is limited', async () => {
  const reset = START_CLOCK + 4 * HOUR;
  const h = controller({
    build: (o, hh) => {
      // God Mode ticked the cards at push time; nothing merged.
      hh.todos = hh.todos.map((t) => ({ ...t, done: true }));
      return {
        ok: true,
        planId: 'p1',
        killed: false,
        integration: { state: 'done', skipped: [], selfCheck: { tests: 'passed', fixups: 0 } },
        plan: { packages: o.cards.map((c) => ({ id: `pk${c.at}`, merged: false, todos: [c.text] })) },
        limitedUntil: reset,
      };
    },
  });
  await h.ctl.start({ projectId: 'game' });
  await h.settle();

  const log = h.log();
  assert.doesNotMatch(log, /build green/);
  assert.match(log, /build limited: 0\/2 cards landed, the builders hit the usage limit; 2 card\(s\) reopened/);
  assert.equal(h.ctl.status().phase, 'building', 'the iteration is not over');
  assert.equal(h.ctl.status().waitReason, 'limit');
  assert.equal(h.ctl.status().waitUntil, reset);
  assert.ok(h.todos.every((t) => !t.done), 'the ticked cards are open again');
});
