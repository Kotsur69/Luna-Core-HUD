// Free God Mode v2 plan run, driven through the controller (orchestra.js
// makePlanRun): a usage limit on ONE worker pauses the WHOLE run, and every
// worker gets RESUME_TEXT when the reset (plus grace) arrives.
//
// The helper unit tests (test/orchestraPauses.test.js) cover the pause maths
// and the 'Pause for shutdown' path covers the manual pause; nothing else
// drives a plan run's limit through the controller. The harness (fake git,
// fake tabs) follows test/orchestra-planrun.test.js and the fake clock follows
// test/orchestra-free.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestra } = require('../src/orchestra');
const { RESUME_TEXT } = require('../src/orchestraSupervisor');

const MINUTE = 60 * 1000;
const RESUME_GRACE_MS = MINUTE; // mirrors src/orchestra.js
const START = new Date(2026, 10, 8, 14, 7, 30).getTime();

const TOPICS = [
  { slug: 'auth-flow', question: 'How should sign-in work?' },
  { slug: 'data-model', question: 'What tables do we need?' },
  { slug: 'billing', question: 'How do we charge?' },
];
const PLAN_PROFILE = { id: 'freellm-auto', command: 'claude', env: { ANTHROPIC_MODEL: 'auto:easy' } };

/** Fake clock + timers + pty writes for a run that pauses and resumes. */
function clocked() {
  const c = { t: START, timers: [], writes: [], events: [] };
  c.deps = {
    now: () => c.t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: c.t + ms, done: false };
      c.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.done = true;
    },
    writePty: (sessionId, text) => {
      c.writes.push([sessionId, text]);
      return true;
    },
    sessionAlive: () => true,
    onRunEvent: (kind, info) => c.events.push([kind, info]),
  };
  c.advance = (ms) => {
    c.t += ms;
    for (const timer of c.timers) {
      if (!timer.done && timer.at <= c.t) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  c.resumeWrites = () => c.writes.filter(([, text]) => text === RESUME_TEXT);
  return c;
}

/** A started plan run with one tab per topic worker (s1..sN, in topic order). */
async function startedPlanRun(t) {
  const c = clocked();
  const log = { sessions: [] };
  const orch = createOrchestra({
    ...c.deps,
    readTodos: () => [],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => {
      throw new Error('a plan run never calls the build planner');
    },
    runTopicSplit: async () => ({ ok: true, raw: { topics: TOPICS }, costUsd: 0 }),
    planProfile: () => PLAN_PROFILE,
    planMcpConfigPath: () => '/cfg/luna-plan-mcp.json',
    addWorktree: async (repo, name, opts) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `${opts.branchPrefix || 'luna/'}${name}` }),
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: (opts) => {
      log.sessions.push(opts);
      return { id: `s${log.sessions.length}` };
    },
  });
  t.after(() => orch.kill && orch.kill());
  const res = await orch.makePlanRun({
    projectId: 'p1', repoPath: '/repo', env: {}, request: 'Plan the auth redesign', planner: 'free', planRunRequest: true,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(log.sessions.length, TOPICS.length, 'every topic worker is running');
  return { orch, c, log };
}

test('a usage limit on one plan-run worker pauses the whole run; every worker resumes at the reset with RESUME_TEXT', async (t) => {
  const { orch, c } = await startedPlanRun(t);
  assert.equal(orch.view().pausedUntil, null, 'nothing paused before the limit');

  // Worker s2 hits the limit; the CLI says it resets in 30 minutes.
  const resetsAt = c.t + 30 * MINUTE;
  orch.onUsageLimit('s2', resetsAt);

  // The whole run waits: one 'all' pause, not a per-backend one.
  assert.equal(orch.view().pausedUntil, resetsAt);
  const paused = c.events.filter(([kind]) => kind === 'paused');
  assert.equal(paused.length, 1);
  assert.deepEqual(paused[0][1], { until: resetsAt, scope: 'all' });
  assert.equal(c.resumeWrites().length, 0, 'nobody is resumed while paused');

  // Still paused just before the reset, and during the grace period.
  c.advance(30 * MINUTE - 1000);
  assert.equal(orch.view().pausedUntil, resetsAt);
  assert.equal(c.resumeWrites().length, 0, 'still waiting before the reset');
  c.advance(RESUME_GRACE_MS - 1000);
  assert.equal(c.resumeWrites().length, 0, 'the grace period after the reset is still waiting');

  // The reset plus grace arrives: ALL workers resume, including the two that never hit a limit.
  c.advance(2000);
  assert.equal(orch.view().pausedUntil, null);
  assert.deepEqual(
    c.resumeWrites().map(([id]) => id).sort(),
    ['s1', 's2', 's3'],
    'every worker of the run is resumed, not only the one that reported the limit',
  );
  assert.equal(c.resumeWrites().length, 3, 'each worker is resumed exactly once');
  assert.ok(c.events.some(([kind, info]) => kind === 'resumed' && info.scope === 'all'));
});

test('a second worker reporting the same limit does not open another pause or resume twice', async (t) => {
  const { orch, c } = await startedPlanRun(t);
  const resetsAt = c.t + 20 * MINUTE;
  orch.onUsageLimit('s1', resetsAt);
  // Another worker, same reset (or earlier): the open whole-run pause already covers it.
  orch.onUsageLimit('s3', resetsAt);
  orch.onUsageLimit('s2', resetsAt - 5 * MINUTE);
  assert.equal(c.events.filter(([kind]) => kind === 'paused').length, 1);
  assert.equal(orch.view().pausedUntil, resetsAt);

  c.advance(20 * MINUTE + RESUME_GRACE_MS);
  assert.equal(orch.view().pausedUntil, null);
  assert.deepEqual(c.resumeWrites().map(([id]) => id).sort(), ['s1', 's2', 's3']);
});

test('a later reset reported by another worker extends the whole-run pause; all resume at the later one', async (t) => {
  const { orch, c } = await startedPlanRun(t);
  const first = c.t + 10 * MINUTE;
  const later = c.t + 25 * MINUTE;
  orch.onUsageLimit('s1', first);
  orch.onUsageLimit('s2', later);
  assert.equal(orch.view().pausedUntil, later, 'the longer wait wins');

  // The first reset passes: nobody resumes yet.
  c.advance(10 * MINUTE + RESUME_GRACE_MS + 1000);
  assert.equal(c.resumeWrites().length, 0);
  assert.equal(orch.view().pausedUntil, later);

  c.advance(15 * MINUTE);
  assert.equal(orch.view().pausedUntil, null);
  assert.deepEqual(c.resumeWrites().map(([id]) => id).sort(), ['s1', 's2', 's3']);
});
