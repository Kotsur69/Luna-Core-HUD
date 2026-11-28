// ============================================================================
// Luna's Work harness-loop guard: the pure half (src/lunasworkHarnessLoop.js)
// and its wiring in the run controller (src/lunasworkDecisionGates.js via
// src/lunaswork.js), the dashboard view and its KPI. Every controller dep is
// a fake; the Critic never passes the milestone and its score keeps rising,
// so neither PLATEAU nor a rollback ends the run first.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const loop = require('../src/lunasworkHarnessLoop');
const { createLunasWork } = require('../src/lunaswork');
const { dashboardView } = require('../src/lunasworkDashboardView');

const REPO = path.resolve(os.tmpdir(), 'lw-harness-loop-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-harness-loop-runs');
const START_CLOCK = 1_700_000_000_000;
const SHA = 'c'.repeat(40);

const clone = (v) => JSON.parse(JSON.stringify(v));
const STOP_CARD = { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' };
const harnessCard = (at) => ({ at, text: `Wire step ${at} into the playtest driver`, done: false, tags: ['run:lwtest1'], size: 'S', files: [`Assets/LunaPlaytest/Step${at}.cs`] });
const gameCard = (at) => ({ at, text: `Enemy wave ${at}`, done: false, tags: ['run:lwtest1'], size: 'S', files: [`Assets/Scripts/Enemies/Wave${at}.cs`] });

const NOT_SCORED = [{ milestone: 'Milestone 1', criterion: 'boss phase two reads clearly', reason: 'the driver cannot reach the boss' }];
const COVERAGE = { planned: 6, run: 2, cut: 0, milestone: 'Milestone 1', milestonePlanned: 3, milestoneRun: 1, criteria: 4, criteriaScored: 2, notRun: [] };

/** A controller with fakes; the Director builds one open card per iteration until `iterations`. */
function harness({ todos, iterations = 6 }) {
  const h = { clock: START_CLOCK, stored: null, timers: [], ended: [], lines: [], directorCalls: 0, todos: clone(todos), score: 10 };
  const deps = {
    store: {
      load: () => (h.stored ? clone(h.stored) : null),
      save: (data) => {
        h.stored = data === null ? null : clone(data);
        return true;
      },
    },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'game' ? { id, repoPath: REPO } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    confirmStart: async () => true,
    todoStore: () => ({
      read: () => h.todos,
      write: (list) => {
        h.todos = list;
        return true;
      },
    }),
    director: async (o) => {
      h.directorCalls += 1;
      if (o.iteration > iterations) return STOP_CARD;
      const next = h.todos.find((t) => !t.done);
      return { ok: true, cards: next ? [next] : [], model: 'opus', modelReason: 'setting' };
    },
    build: async (o) => {
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true } : t));
      return {
        ok: true,
        planId: 'p1',
        killed: false,
        integration: { state: 'done', error: null, skipped: [], headSha: SHA, selfCheck: { tests: 'passed', fixups: 0, pushedIntegrationBranch: null } },
        plan: { packages: o.cards.map((c) => ({ id: `pk${c.at}`, branch: `luna/pk${c.at}-aaaaa`, merged: true, todos: [c.text], touched: c.files || [] })) },
      };
    },
    createAdapter: (name, o) => ({
      name,
      evidenceDir: path.join(EVIDENCE, `lunaswork-${o.runId}`, `iter-${o.iteration}`),
      start: async () => ({ url: 'http://localhost:3000' }),
      stop: async () => true,
      tools: () => ({}),
    }),
    playtest: async (o) => ({
      ok: true,
      mode: o.mode,
      model: 'sonnet',
      modelReason: 'exploratory pass',
      report: { mode: o.mode, findings: [], scores: [], journeys: [{ name: 'j', passed: true }], screens: [], notScored: NOT_SCORED, coverage: COVERAGE },
    }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => {
      h.score += 5;
      return {
        ok: true,
        verdict: 'continue',
        model: 'sonnet',
        modelReason: 'regular iteration',
        milestone: { name: 'Milestone 1', passed: false, score: h.score },
        next: 'Milestone 1',
        allPassed: false,
        decisions: [{ choice: 'the loop has drifted into harness plumbing', because: 'four driver cards in a row' }],
      };
    },
    gitLog: async () => 'abc123 a commit',
    syncCheckout: async () => ({ ok: true }),
    recordDecision: (ctx) => {
      h.lines.push(ctx.line);
      return true;
    },
    onRunEnd: [(run) => h.ended.push(run)],
    newRunId: () => 'lwtest1',
    now: () => h.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock + ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    log: () => {},
  };
  const ctl = createLunasWork(deps);
  h.ctl = ctl;
  h.settle = async () => {
    for (let i = 0; i < 5; i += 1) await ctl.idle();
  };
  h.start = async () => {
    await ctl.start({ projectId: 'game' });
    await h.settle();
  };
  h.fire = async () => {
    const pending = h.timers.filter((t) => !t.cleared).sort((a, b) => a.at - b.at);
    assert.ok(pending.length, 'a timer is pending');
    const t = pending[0];
    t.cleared = true;
    h.clock = Math.max(h.clock, t.at);
    t.fn();
    await h.settle();
  };
  h.answer = async (answer) => {
    const d = h.ctl.status().pendingDecisions[0];
    assert.ok(d, 'a decision is pending');
    const res = h.ctl.answer({ id: d.id, answer, runId: 'lwtest1' });
    assert.equal(res.ok, true, JSON.stringify(res));
    await h.settle();
  };
  h.log = () => h.ctl.runLog().map((e) => e.text || '');
  h.loopDecisions = () => (h.stored.decisions || []).filter((d) => d.kind === 'harnessLoop');
  return h;
}

// ---- harness cards -----------------------------------------------------------------

test('isHarnessCard: playtest bridge / driver / command / snapshot / dev-script files only', () => {
  for (const f of ['Assets/LunaPlaytest/Bridge.cs', 'Assets/Scripts/PlaytestDriver.cs', 'Assets/Editor/PlaytestCommands.cs',
    'Assets/Scripts/Dev/Reset.cs', 'Assets\\LunaPlaytest\\Snapshot.cs', 'Assets/Scripts/PlaytestSnapshot.cs.meta']) {
    assert.equal(loop.isHarnessPath(f), true, f);
  }
  for (const f of ['Assets/Scripts/Player/Jump.cs', 'Assets/Scenes/Main.unity', 'src/devtools.js', '']) assert.equal(loop.isHarnessPath(f), false, f);
  assert.equal(loop.isHarnessCard({ text: 'x', files: ['Assets/LunaPlaytest/A.cs', 'Assets/Scripts/Dev/B.cs'] }), true);
  // One gameplay file is enough to make it a gameplay card.
  assert.equal(loop.isHarnessCard({ text: 'Dash', files: ['Assets/LunaPlaytest/A.cs', 'Assets/Scripts/Player/Dash.cs'] }), false);
});

test('isHarnessCard: text and tags mark harness work; gameplay text does not', () => {
  assert.equal(loop.isHarnessCard({ text: 'Teach the send_input dialect button steps' }), true);
  assert.equal(loop.isHarnessCard({ text: 'Run BuildSandbox over the CLI' }), true);
  assert.equal(loop.isHarnessCard({ text: 'Make snapshots visible', details: 'The playtest snapshot misses the HUD' }), true);
  assert.equal(loop.isHarnessCard({ text: 'Fix it', tags: ['run:x', 'harness'] }), true);
  assert.equal(loop.isHarnessCard({ text: 'Fix the jump the playtest found', files: ['Assets/Scripts/Player/Jump.cs'] }), false);
  assert.equal(loop.isHarnessCard(null), false);
});

test('harnessTally: landed files win over the predicted ones', () => {
  const cards = [
    { at: 1, text: 'Enemy AI', files: ['Assets/Scripts/Enemy.cs'] },
    { at: 2, text: 'Boss', files: ['Assets/Scripts/Boss.cs'] },
  ];
  const merges = { headSha: SHA, packages: [{ id: 'a', cards: [1], touched: ['Assets/LunaPlaytest/Driver.cs'] }] };
  assert.deepEqual(loop.harnessTally(cards, merges), { cards: 2, harness: 1 });
  assert.deepEqual(loop.harnessTally(cards, null), { cards: 2, harness: 0 });
  assert.deepEqual(loop.harnessTally(null, null), { cards: 0, harness: 0 });
});

// ---- state and triggers -------------------------------------------------------------

const record = (state, n, extra = {}) => loop.recordIteration(state, { n, milestone: 'M1', passed: false, cards: 2, harness: 0, ...extra });

test('recordIteration: counts iterations without a pass, resets on a pass or a new milestone, never counts one twice', () => {
  let s = loop.emptyLoop();
  s = record(s, 1);
  s = record(s, 2);
  assert.equal(s.stalled, 2);
  assert.equal(record(s, 2).stalled, 2, 'the same iteration again changes nothing');
  assert.equal(record(s, 3, { passed: true }).stalled, 0);
  const next = record(s, 3, { milestone: 'M2' });
  assert.equal(next.milestone, 'M2');
  assert.equal(next.stalled, 1);
  assert.deepEqual(next.window.map((w) => w.n), [3]);
  // Only the last SHARE_WINDOW iterations are kept.
  for (let n = 3; n <= 6; n += 1) s = record(s, n);
  assert.deepEqual(s.window.map((w) => w.n), [4, 5, 6]);
});

test('loopTrigger: K non-passing iterations on one milestone trigger once', () => {
  let s = loop.emptyLoop();
  for (let n = 1; n < loop.STALL_ITERATIONS; n += 1) {
    s = record(s, n);
    assert.equal(loop.loopTrigger(s), null, `not yet after ${n}`);
  }
  s = record(s, loop.STALL_ITERATIONS);
  const hit = loop.loopTrigger(s);
  assert.deepEqual(hit.triggers, ['stalled']);
  s = { ...s, asked: [...s.asked, ...hit.keys] };
  s = record(s, loop.STALL_ITERATIONS + 1);
  assert.equal(loop.loopTrigger(s), null, 'not asked again for the same milestone');
  // A new milestone that stalls is asked about again.
  for (let n = 10; n < 10 + loop.STALL_ITERATIONS; n += 1) s = record(s, n, { milestone: 'M2' });
  assert.deepEqual(loop.loopTrigger(s).triggers, ['stalled']);
});

test('harnessShare: computed over the last 3 iterations; more than half triggers', () => {
  let s = loop.emptyLoop();
  s = record(s, 1, { cards: 3, harness: 2 });
  s = record(s, 2, { cards: 3, harness: 3 });
  assert.equal(loop.harnessShare(s).share, null, 'not before a full window');
  assert.equal(loop.loopTrigger(s), null);
  s = record(s, 3, { cards: 2, harness: 1 });
  assert.deepEqual(loop.harnessShare(s), { cards: 8, harness: 6, share: 0.75, iterations: 3 });
  assert.deepEqual(loop.loopTrigger(s).triggers, ['harness']);
  assert.deepEqual(loop.loopCounts(s), { milestone: 'M1', iterations: 3, stallLimit: 4, harnessPercent: 75, harnessCards: 6, cards: 8, window: 3 });
  // Exactly half is not "more than half".
  let half = loop.emptyLoop();
  for (let n = 1; n <= 3; n += 1) half = record(half, n, { cards: 2, harness: 1 });
  assert.equal(loop.loopTrigger(half), null);
});

test('restoreLoop: an old run (no field) and broken input load as the empty state', () => {
  assert.deepEqual(loop.restoreLoop(undefined), loop.emptyLoop());
  const s = loop.restoreLoop({ milestone: 'M1', stalled: -3, window: [{ n: 1, cards: 2, harness: 9 }, { n: 'x' }], asked: ['M1|stalled', 5], decisionId: 'no', trigger: 'evil' });
  assert.equal(s.stalled, 0);
  assert.deepEqual(s.window, [{ n: 1, cards: 2, harness: 2 }]);
  assert.deepEqual(s.asked, ['M1|stalled']);
  assert.equal(s.decisionId, null);
  assert.equal(s.trigger, null);
});

test("loopDecision: the Critic's summary and the playtest coverage, keep going by default", () => {
  const counts = { milestone: 'Milestone 1', iterations: 4, stallLimit: 4, harnessPercent: 83, harnessCards: 5, cards: 6, window: 3 };
  const critic = { milestone: { name: 'Milestone 1', score: 41 }, decisions: [{ choice: 'the loop has drifted into harness plumbing', because: 'driver cards' }] };
  const spec = loop.loopDecision({ triggers: ['stalled', 'harness'], counts, critic, report: { notScored: NOT_SCORED, coverage: COVERAGE }, milestone: 'Milestone 1' });
  assert.equal(spec.kind, 'harnessLoop');
  assert.deepEqual(spec.options, ['keep-going', 'drop-criterion', 'stop']);
  assert.equal(spec.defaultAnswer, 'keep-going');
  assert.match(spec.question, /Milestone "Milestone 1" has run 4 iterations without passing its gate, and 5 of the last 6 cards \(3 iterations\) were playtest-harness work/);
  assert.match(spec.detail, /Critic: Milestone 1 at 41, not passed/);
  assert.match(spec.detail, /the loop has drifted into harness plumbing/);
  assert.match(spec.detail, /not scored: "boss phase two reads clearly"/);
  assert.match(spec.detail, /journeys run 2\/6/);
  assert.ok(spec.detail.length <= 300);
  assert.match(loop.dropCriterionLine({ milestone: 'Milestone 1', criterion: 'boss phase two reads clearly', date: '2026-11-28' }),
    /^- Gate change \(2026-11-28, Mati\): "boss phase two reads clearly" is dropped from the Milestone 1 milestone gate/);
});

// ---- the controller -----------------------------------------------------------------

const gameplayTodos = () => Array.from({ length: 10 }, (_, i) => gameCard(i + 1));

test('controller: K non-passing iterations on one milestone raise the decision once; keep going continues', async () => {
  const h = harness({ todos: gameplayTodos(), iterations: 7 });
  await h.start();
  const s = h.ctl.status();
  assert.equal(s.waitReason, 'harnessLoop');
  assert.equal(s.iteration, loop.STALL_ITERATIONS + 1);
  assert.equal(h.directorCalls, loop.STALL_ITERATIONS, 'the next iteration waits');
  assert.equal(h.loopDecisions().length, 1);
  assert.equal(s.pendingDecisions[0].kind, 'harnessLoop');
  assert.ok(h.log().some((t) => /harness loop on Milestone 1 \(4 iteration\(s\) without a pass, harness 0% of the last 3 iterations' cards\): iteration 5 waits for Mati/.test(t)), h.log().join('\n'));
  await h.answer('keep-going');
  assert.equal(h.ended.length, 1, 'the run went on to its end');
  assert.equal(h.loopDecisions().length, 1, 'never asked again for the same milestone');
  assert.ok(h.ended[0].history.length >= 7);
  assert.ok(h.log().some((t) => /harness loop on Milestone 1: keep going \(decision \d+, answered by Mati\)/.test(t)));
});

test('controller: a harness-heavy last 3 iterations raise the same decision before K', async () => {
  const h = harness({ todos: Array.from({ length: 8 }, (_, i) => harnessCard(i + 1)), iterations: 6 });
  await h.start();
  const s = h.ctl.status();
  assert.equal(s.waitReason, 'harnessLoop');
  assert.equal(s.iteration, 4, 'asked after iteration 3');
  assert.equal(h.stored.harnessLoop.trigger, 'harness');
  const d = s.pendingDecisions[0];
  assert.match(d.question, /3 of the last 3 cards \(3 iterations\) were playtest-harness work/);
  assert.deepEqual(d.options, ['keep-going', 'drop-criterion', 'stop']);
  // The dashboard view carries the counts.
  const view = dashboardView(h.ctl.snapshot(), { runsRoot: EVIDENCE, isKnownProject: () => true });
  assert.deepEqual(view.loop, { milestone: 'Milestone 1', iterations: 3, stallLimit: 4, harnessPercent: 100, harnessCards: 3, cards: 3, window: 3 });
  // Once answered, iteration 4's stall does not ask a second time.
  await h.answer('keep-going');
  assert.equal(h.loopDecisions().length, 1);
  assert.equal(h.ended.length, 1);
});

test('controller: the timeout takes the default - keep going - and the run continues', async () => {
  const h = harness({ todos: gameplayTodos(), iterations: 5 });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'harnessLoop');
  const calls = h.directorCalls;
  await h.fire();
  assert.ok(h.directorCalls > calls, 'the next iteration started');
  assert.equal(h.ended.length, 1);
  const d = h.ended[0].decisions.find((x) => x.kind === 'harnessLoop');
  assert.deepEqual([d.answer, d.answeredBy], ['keep-going', 'default']);
  assert.ok(h.log().some((t) => /keep going \(decision \d+, default after deadline\)/.test(t)));
});

test("controller: 'stop' ends the run with a stopReason", async () => {
  const h = harness({ todos: gameplayTodos(), iterations: 7 });
  await h.start();
  await h.answer('stop');
  const s = h.ctl.status();
  assert.equal(s.active, false);
  assert.equal(s.verdict, 'stop');
  assert.equal(s.stopReason, 'harnessLoop');
  assert.equal(h.directorCalls, loop.STALL_ITERATIONS, 'no further iteration');
});

test("controller: 'drop-criterion' writes the gate change into DECISIONS.md for the Critic and goes on", async () => {
  const h = harness({ todos: gameplayTodos(), iterations: 5 });
  await h.start();
  await h.answer('drop-criterion');
  assert.ok(h.lines.some((l) => /^- Gate change \(\d{4}-\d\d-\d\d, Mati\): "boss phase two reads clearly" is dropped from the Milestone 1 milestone gate/.test(l)), h.lines.join('\n'));
  assert.ok(h.lines.some((l) => /Decision queue, harnessLoop: .* -> drop-criterion - answered by Mati/.test(l)));
  assert.equal(h.ended.length, 1, 'the run went on');
});

test('dashboard: loopKpi shows the iterations and the harness share', async () => {
  const { loopKpi } = await import('../src/renderer/modules/lunasworkDashboard.js');
  assert.deepEqual(loopKpi({ iterations: 3, stallLimit: 4, harnessPercent: 67, window: 3 }), { value: '3 / 4', subKey: 'lw.dash.loopSub', subVars: { pct: 67, n: 3 } });
  assert.deepEqual(loopKpi({ iterations: 1, stallLimit: 4, harnessPercent: null, window: 1 }), { value: '1 / 4', subKey: 'lw.dash.loopSubNone', subVars: {} });
  assert.deepEqual(loopKpi(null), { value: '0', subKey: 'lw.dash.loopSubNone', subVars: {} });
  // An old run without the field: the view still has the counts, all zero.
  assert.equal(dashboardView({ id: 'lwold1', phase: 'directing', laps: [], history: [] }, { runsRoot: EVIDENCE, isKnownProject: () => true }).loop.iterations, 0);
});
