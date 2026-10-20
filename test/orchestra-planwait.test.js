// ============================================================================
// God Mode: planning that hits the 5 h / weekly Claude limit waits for the
// reset and plans on its own (src/orchestraPlanWait.js + orchestra.js wiring).
// Decision logic is pure; the waiter and makePlan run on fake timers.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isUsageLimitText,
  resetFromText,
  planWaitDecision,
  createPlanWaiter,
  RESUME_GRACE_MS,
  FALLBACK_WAIT_MS,
  MIN_WAIT_MS,
} = require('../src/orchestraPlanWait');
const { parsePlannerOutput } = require('../src/orchestraPlan');
const { createOrchestra } = require('../src/orchestra');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const limits = ({ five = 40, week = 30, fiveReset = NOW + 3600e3, weekReset = NOW + 3 * 86400e3 } = {}) => [
  { window: '5h', percentUsed: five, resetsAt: iso(fiveReset) },
  { window: 'weekly', percentUsed: week, resetsAt: iso(weekReset) },
];

// --- classification --------------------------------------------------------------

test('isUsageLimitText knows the CLI limit messages and not a dollar cap', () => {
  assert.equal(isUsageLimitText('Claude AI usage limit reached|1792497600'), true);
  assert.equal(isUsageLimitText("You've hit your limit · resets 5pm (Europe/Warsaw)"), true);
  assert.equal(isUsageLimitText('5-hour limit reached'), true);
  assert.equal(isUsageLimitText('Reached maximum budget ($3)'), false);
  assert.equal(isUsageLimitText(''), false);
});

test('resetFromText reads the epoch after the pipe, seconds or ms', () => {
  assert.equal(resetFromText('Claude AI usage limit reached|1792497600'), 1792497600000);
  assert.equal(resetFromText('limit|1792497600000'), 1792497600000);
  assert.equal(resetFromText('no epoch here'), null);
});

test('parsePlannerOutput classifies a usage-limit envelope as limit, a cost cap as budget', () => {
  const limit = parsePlannerOutput(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1792497600' }));
  assert.equal(limit.error, 'limit');
  assert.match(limit.detail, /1792497600/);
  const cap = parsePlannerOutput(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' }));
  assert.equal(cap.error, 'budget');
});

// --- decision --------------------------------------------------------------------

test('success and unrelated failures are not waits', () => {
  assert.deepEqual(planWaitDecision({ res: { ok: true }, now: NOW }), { action: 'none' });
  assert.deepEqual(planWaitDecision({ res: { ok: false, error: 'timeout' }, limits: limits({ five: 100 }), now: NOW }), { action: 'fail' });
});

test('a real dollar cap with windows left still fails', () => {
  const d = planWaitDecision({ res: { ok: false, error: 'budget', detail: 'error_max_budget_usd' }, limits: limits(), now: NOW });
  assert.deepEqual(d, { action: 'fail' });
});

test('limit with a CLI reset epoch waits until just after it', () => {
  const at = NOW + 2 * 3600e3;
  const d = planWaitDecision({ res: { ok: false, error: 'limit', detail: `usage limit reached|${at / 1000}` }, limits: limits(), now: NOW });
  assert.equal(d.action, 'wait');
  assert.equal(d.source, 'cli');
  assert.equal(d.resumeAt, at + RESUME_GRACE_MS);
});

test('budget error with a spent 5 h window waits for the 5 h reset from usage.js', () => {
  const fiveReset = NOW + 45 * 60e3;
  const d = planWaitDecision({ res: { ok: false, error: 'budget', detail: '' }, limits: limits({ five: 100, fiveReset }), now: NOW });
  assert.deepEqual(d, { action: 'wait', resumeAt: fiveReset + RESUME_GRACE_MS, window: '5h', source: 'usage' });
});

test('a spent weekly window wins over the 5 h one', () => {
  const weekReset = NOW + 2 * 86400e3;
  const d = planWaitDecision({ res: { ok: false, error: 'limit' }, limits: limits({ five: 100, week: 100, weekReset }), now: NOW });
  assert.equal(d.window, 'weekly');
  assert.equal(d.resumeAt, weekReset + RESUME_GRACE_MS);
});

test('limit with no usable reset time re-probes after the fallback wait', () => {
  const d = planWaitDecision({ res: { ok: false, error: 'limit' }, limits: [], now: NOW });
  assert.equal(d.source, 'fallback');
  assert.equal(d.resumeAt, NOW + FALLBACK_WAIT_MS + RESUME_GRACE_MS);
});

test('a reset already in the past never schedules sooner than the minimum wait', () => {
  const d = planWaitDecision({ res: { ok: false, error: 'limit', detail: `limit|${(NOW - 5000) / 1000}` }, limits: limits({ fiveReset: NOW - 1000 }), now: NOW });
  assert.ok(d.resumeAt >= NOW + MIN_WAIT_MS);
});

// --- waiter ----------------------------------------------------------------------

function fakeClock() {
  let t = NOW;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.live = false;
    },
    /** Moves the clock forward and runs every due timer. */
    async advance(ms) {
      t += ms;
      for (const timer of timers.filter((x) => x.live && x.at <= t)) {
        timer.live = false;
        await timer.fn();
      }
    },
    live: () => timers.filter((x) => x.live).length,
  };
}

test('waiter fires replan at resumeAt and clears itself on success', async () => {
  const clock = fakeClock();
  const states = [];
  let replans = 0;
  const w = createPlanWaiter({ ...clock, onChange: (s) => states.push(s && s.state), replan: async () => { replans += 1; return { ok: true }; } });
  w.arm({ projectId: 'p1' }, { resumeAt: NOW + 1000, window: '5h', source: 'usage' });
  assert.equal(w.view().resumeAt, NOW + 1000);
  await clock.advance(999);
  assert.equal(replans, 0);
  await clock.advance(1);
  assert.equal(replans, 1);
  assert.deepEqual(states, ['waiting', 'planning', null]);
  assert.equal(w.view(), null);
});

test('cancel stops the timer; nothing fires later', async () => {
  const clock = fakeClock();
  let replans = 0;
  const w = createPlanWaiter({ ...clock, onChange: () => {}, replan: async () => { replans += 1; return { ok: true }; } });
  w.arm({ projectId: 'p1' }, { resumeAt: NOW + 1000, window: null, source: 'fallback' });
  assert.deepEqual(w.cancel(), { ok: true });
  await clock.advance(5000);
  assert.equal(replans, 0);
  assert.deepEqual(w.cancel(), { ok: false, error: 'notWaiting' });
});

test('a replan that fails for another reason ends in a failed state', async () => {
  const clock = fakeClock();
  const w = createPlanWaiter({ ...clock, onChange: () => {}, replan: async () => ({ ok: false, error: 'noTodos' }) });
  w.arm({ projectId: 'p1' }, { resumeAt: NOW + 10, window: '5h', source: 'usage' });
  await clock.advance(10);
  assert.deepEqual([w.view().state, w.view().error], ['failed', 'noTodos']);
});

// --- orchestra integration ----------------------------------------------------------

function orchestraWith(results, usage) {
  const clock = fakeClock();
  const waits = [];
  const calls = { planner: 0 };
  const orch = createOrchestra({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => {
      calls.planner += 1;
      return results.shift();
    },
    addWorktree: async () => ({ ok: false }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    usageLimits: () => usage,
    onPlanWait: (s) => waits.push(s),
  });
  return { orch, clock, waits, calls };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };
const goodPlan = { ok: true, raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' }], notes: '' }, costUsd: 0.1 };

test('makePlan parks on a spent limit, then plans by itself after the reset', async () => {
  const fiveReset = NOW + 30 * 60e3;
  const { orch, clock, waits, calls } = orchestraWith(
    [{ ok: false, error: 'limit', detail: 'usage limit reached' }, goodPlan],
    limits({ five: 100, fiveReset }),
  );
  const res = await orch.makePlan(ctx);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'waiting');
  assert.equal(res.planWait.resumeAt, fiveReset + RESUME_GRACE_MS);
  assert.equal(orch.view(), null);

  await clock.advance(fiveReset + RESUME_GRACE_MS - NOW);
  assert.equal(calls.planner, 2);
  assert.equal(orch.view().packages.length, 1);
  assert.equal(orch.planWait(), null);
  assert.deepEqual(waits.map((s) => s && s.state), ['waiting', 'planning', null]);
});

test('still limited at the reset -> waits again instead of failing', async () => {
  const { orch, clock, calls } = orchestraWith(
    [{ ok: false, error: 'limit' }, { ok: false, error: 'limit' }],
    limits({ five: 100, fiveReset: NOW + 1000 }),
  );
  await orch.makePlan(ctx);
  await clock.advance(1000 + RESUME_GRACE_MS);
  assert.equal(calls.planner, 2);
  assert.equal(orch.planWait().state, 'waiting');
});

test('cancelPlanWait drops the wait and a manual re-plan replaces it', async () => {
  const { orch, clock, calls } = orchestraWith(
    [{ ok: false, error: 'limit' }, { ok: false, error: 'limit' }, goodPlan],
    limits({ five: 100 }),
  );
  await orch.makePlan(ctx);
  assert.deepEqual(orch.cancelPlanWait(), { ok: true });
  assert.equal(orch.planWait(), null);
  await orch.makePlan(ctx); // waits again
  const res = await orch.makePlan(ctx); // manual re-plan: replaces the wait
  assert.equal(res.ok, true);
  assert.equal(orch.planWait(), null);
  await clock.advance(7 * 86400e3);
  assert.equal(calls.planner, 3, 'the replaced wait never fires');
});

test('a true budget cap still fails at once', async () => {
  const { orch } = orchestraWith([{ ok: false, error: 'budget', detail: 'error_max_budget_usd' }], limits());
  const res = await orch.makePlan(ctx);
  assert.equal(res.error, 'budget');
  assert.equal(orch.planWait(), null);
});
