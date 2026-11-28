// ============================================================================
// Luna's Work: a failed rollback asks Mati before the next iteration
// (src/lunasworkDecisionGates.js, wired in src/lunaswork.js). Every dep is a
// fake: store, Director, builder, adapter, Playtester, Critic, checkpoints,
// clock and timers. A score drop past the margin triggers the rollback; the
// fake checkpoints.rollback answers {ok:false, error:'revertFailed'}.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { createLunasWork, restoreRun } = require('../src/lunaswork');
const { rollbackDecision, cleanRollbackHold, ROLLBACK_OPTIONS, KEEP, ROLLBACK_DEADLINE_MS } = require('../src/lunasworkDecisionGates');

const REPO = path.resolve(os.tmpdir(), 'lw-rollback-decision-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-rollback-decision-runs');
const START_CLOCK = 1_700_000_000_000;

const clone = (v) => JSON.parse(JSON.stringify(v));
const card = (at) => ({ at, text: `card ${at}`, done: false, tags: ['run:lwtest1'], size: 'S' });
const STOP_CARD = { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' };
const FAILED_ROLLBACK = { ok: false, error: 'revertFailed', detail: 'conflict in Assets/Scenes/Main.unity', fromTag: 'f', toTag: 'luna-work/lwtest1/iter-1' };

/** The checkpoint fake: tags every green iteration; rollback() returns `answer`. */
function fakeCheckpoints(answer) {
  const cp = { tags: [], rollbacks: [] };
  cp.dep = {
    tagIteration: async (o) => {
      cp.tags.push(o);
      return { ok: true, tag: `luna-work/${o.runId}/iter-${o.iteration}` };
    },
    rollback: async (o) => {
      cp.rollbacks.push(o);
      return typeof answer === 'function' ? answer(o) : answer;
    },
  };
  return cp;
}

/**
 * A controller with fakes. The Critic scores from `scores` (then 50); the
 * Director builds one open card per iteration until `iterations`, then stops.
 */
function harness({ scores = [], iterations = 3, checkpoints, stored = null, todos = null } = {}) {
  const h = {
    clock: START_CLOCK,
    stored: stored ? clone(stored) : null,
    timers: [],
    ended: [],
    syncs: 0,
    directorCalls: 0,
    todos: todos || Array.from({ length: 8 }, (_, i) => card(i + 1)),
    scores: [...scores],
  };
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
        integration: { state: 'done', error: null, skipped: [], selfCheck: { tests: 'passed', fixups: 0, pushedIntegrationBranch: null } },
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text) }] },
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
      report: { mode: o.mode, findings: [], scores: [], journeys: [{ name: 'j', passed: true }], screens: [] },
    }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({
      ok: true,
      verdict: 'continue',
      model: 'sonnet',
      modelReason: 'regular iteration',
      milestone: { name: 'skeleton', passed: false, score: h.scores.length ? h.scores.shift() : 50 },
      next: 'skeleton',
      allPassed: false,
    }),
    gitLog: async () => 'abc123 a commit',
    syncCheckout: async () => {
      h.syncs += 1;
      return { ok: true };
    },
    checkpoints: checkpoints.dep,
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
    const res = await ctl.start({ projectId: 'game' });
    await h.settle();
    return res;
  };
  /** Fires the earliest pending timer at its time, then lets the loop run. */
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
  return h;
}

/** Iteration 1 scores 76, iteration 2 falls to 4: the rollback is triggered and fails. */
async function failedRollbackRun(opts = {}) {
  const cp = fakeCheckpoints(FAILED_ROLLBACK);
  const h = harness({ scores: [76, 4, 80], checkpoints: cp, ...opts });
  await h.start();
  return { h, cp };
}

// ---- the question ----------------------------------------------------------------

test('rollbackDecision: three options, keep by default, the error and the last good tag in it', () => {
  const spec = rollbackDecision({ n: 9, rollback: { ...FAILED_ROLLBACK, toIteration: 8, why: 'score fell from 76 to 4' } });
  assert.equal(spec.kind, 'rollbackFailed');
  assert.deepEqual(spec.options, ['revert-by-hand', 'keep', 'stop']);
  assert.deepEqual(ROLLBACK_OPTIONS, spec.options);
  assert.equal(spec.defaultAnswer, KEEP);
  assert.equal(spec.deadlineMs, ROLLBACK_DEADLINE_MS);
  assert.match(spec.question, /Iteration 9 regressed \(score fell from 76 to 4\) and the rollback to iteration 8 failed \(revertFailed\)/);
  assert.match(spec.detail, /last good tag luna-work\/lwtest1\/iter-1; conflict in Assets/);
});

test('cleanRollbackHold: old runs (no field) and broken ones load as no hold', async () => {
  assert.equal(cleanRollbackHold(undefined), null);
  assert.equal(cleanRollbackHold({ n: 0 }), null);
  assert.deepEqual(cleanRollbackHold({ n: 2, decisionId: 5, toIteration: 1, cards: [2, 2, -1, 'x'] }), { n: 2, decisionId: 5, toIteration: 1, cards: [2] });
  // A run saved before these fields existed still loads, with no hold and an empty loop count.
  const { h } = await failedRollbackRun();
  const old = clone(h.stored);
  delete old.rollbackHold;
  delete old.harnessLoop;
  const back = restoreRun(old);
  assert.ok(back, 'the old run loads');
  assert.equal(back.rollbackHold, null);
  assert.equal(back.harnessLoop.stalled, 0);
  assert.equal(restoreRun(h.stored).rollbackHold.n, 2);
});

// ---- the controller ----------------------------------------------------------------

test('a failed rollback raises a decision and the next iteration does not start until it is answered', async () => {
  const { h, cp } = await failedRollbackRun();
  assert.equal(cp.rollbacks.length, 1);
  assert.equal(cp.rollbacks[0].reason, 'scoreDrop');
  const s = h.ctl.status();
  assert.equal(s.active, true);
  assert.equal(s.phase, 'directing');
  assert.equal(s.iteration, 3);
  assert.equal(s.waitReason, 'rollbackFailed');
  assert.equal(s.waitUntil, START_CLOCK + ROLLBACK_DEADLINE_MS);
  // The Director ran for iterations 1 and 2 only: iteration 3 waits.
  assert.equal(h.directorCalls, 2);
  assert.equal(s.pendingDecisions.length, 1);
  const d = s.pendingDecisions[0];
  assert.equal(d.kind, 'rollbackFailed');
  assert.deepEqual(d.options, ['revert-by-hand', 'keep', 'stop']);
  assert.equal(d.defaultAnswer, 'keep');
  assert.equal(h.stored.rollbackHold.n, 2);
  assert.equal(h.stored.rollbackHold.decisionId, d.id);
  // One clear line says what waits and why.
  assert.ok(h.log().some((t) => /^rollback failed: iteration 3 waits for Mati \(decision \d+\): revert main by hand and resume, keep iteration 2, or stop the run - default keep at \d\d:\d\d UTC$/.test(t)), h.log().join('\n'));
  assert.ok(h.log().some((t) => /rollback failed \(revertFailed: conflict in Assets\/Scenes\/Main\.unity\) - main still has iteration 2/.test(t)));
});

test("a failed rollback: 'keep' resumes as before - main keeps the iteration and its cards", async () => {
  const { h } = await failedRollbackRun();
  await h.answer('keep');
  assert.equal(h.directorCalls >= 3, true, 'iteration 3 was directed');
  assert.equal(h.ended.length, 1, 'the run went on to its end');
  const run = h.ended[0];
  assert.equal(run.verdict, 'stop');
  assert.deepEqual(run.history.map((r) => r.rolledBack), [false, false, false]);
  assert.equal(h.todos.find((t) => t.at === 2).done, true, 'nothing reopened');
  assert.equal(run.rollbackHold, null);
  assert.ok(h.log().some((t) => /failed rollback of iteration 2: main keeps it and the run continues \(decision \d+, answered by Mati\)/.test(t)));
});

test("a failed rollback: 'stop' ends the run with a stopReason", async () => {
  const { h } = await failedRollbackRun();
  await h.answer('stop');
  const s = h.ctl.status();
  assert.equal(s.active, false);
  assert.equal(s.verdict, 'stop');
  assert.equal(s.stopReason, 'rollbackFailed');
  assert.equal(h.directorCalls, 2, 'iteration 3 never started');
  assert.equal(h.ended.length, 1);
  assert.ok(h.log().some((t) => /failed rollback of iteration 2: the run stops/.test(t)));
});

test("a failed rollback: 'revert-by-hand' reopens the iteration's cards, marks it rolled back and syncs the checkout", async () => {
  const { h } = await failedRollbackRun();
  const syncsBefore = h.syncs;
  await h.answer('revert-by-hand');
  assert.ok(h.syncs > syncsBefore, 'the checkout was synced');
  const run = h.ended[0];
  assert.deepEqual(run.history.slice(0, 2).map((r) => r.rolledBack), [false, true]);
  assert.equal(run.laps.find((l) => l.n === 2).rolledBack, true);
  assert.ok(h.log().some((t) => /iteration 2 reverted by hand: 1 card\(s\) reopened/.test(t)));
  // Card 2 was reopened, then built again by iteration 3.
  assert.ok(h.ended[0].history.length >= 3);
});

test('a failed rollback: the timeout takes the default - the run continues as before', async () => {
  const { h } = await failedRollbackRun();
  assert.equal(h.directorCalls, 2);
  await h.fire();
  assert.ok(h.directorCalls >= 3, 'iteration 3 started after the deadline');
  const run = h.ended[0];
  const d = run.decisions.find((x) => x.kind === 'rollbackFailed');
  assert.equal(d.answer, 'keep');
  assert.equal(d.answeredBy, 'default');
  assert.deepEqual(run.history.map((r) => r.rolledBack), [false, false, false]);
  assert.ok(h.log().some((t) => /main keeps it and the run continues \(decision \d+, default after deadline\)/.test(t)));
});

test('a failed rollback: a restart while waiting waits again and never asks twice', async () => {
  const { h } = await failedRollbackRun();
  const stored = clone(h.stored);
  await h.ctl.dispose();
  const again = harness({ scores: [80], checkpoints: fakeCheckpoints(FAILED_ROLLBACK), stored, todos: h.todos });
  assert.equal(again.ctl.resume(), true);
  await again.settle();
  const s = again.ctl.status();
  assert.equal(s.waitReason, 'rollbackFailed');
  assert.equal(s.pendingDecisions.length, 1);
  assert.equal(again.directorCalls, 0);
  assert.equal(again.stored.decisions.filter((d) => d.kind === 'rollbackFailed').length, 1);
});

test('a successful rollback is unchanged: no decision, no wait, and the log names the method', async () => {
  const cp = fakeCheckpoints((o) => ({
    ok: true,
    method: 'tree',
    fromTag: `luna-work/${o.runId}/iter-${o.iteration}-rolled-back`,
    toTag: `luna-work/${o.runId}/iter-${o.toIteration}`,
    reverted: [{ sha: 'b'.repeat(40), subject: 'Merge package pk' }],
    cards: [99],
    decision: true,
  }));
  const h = harness({ scores: [76, 4, 80], checkpoints: cp });
  await h.start();
  assert.equal(h.ended.length, 1, 'the run never waited');
  const run = h.ended[0];
  assert.equal(run.decisions.filter((d) => d.kind === 'rollbackFailed').length, 0);
  assert.deepEqual(run.history.map((r) => r.rolledBack), [false, true, false]);
  assert.equal(run.laps[1].checkpoint.rollback.method, 'tree');
  assert.ok(h.log().some((t) => /^rolled back luna-work\/lwtest1\/iter-2-rolled-back -> luna-work\/lwtest1\/iter-1 \(method tree\): 1 revert commit/.test(t)), h.log().join('\n'));
});

test('a successful rollback without a method in the result logs the revert method', async () => {
  const cp = fakeCheckpoints((o) => ({ ok: true, fromTag: 'a', toTag: `luna-work/${o.runId}/iter-1`, reverted: [], cards: [] }));
  const h = harness({ scores: [76, 4], iterations: 2, checkpoints: cp });
  await h.start();
  assert.ok(h.log().some((t) => /^rolled back a -> luna-work\/lwtest1\/iter-1 \(method revert\)/.test(t)));
});
