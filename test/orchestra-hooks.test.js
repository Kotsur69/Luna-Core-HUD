// ============================================================================
// orchestra.js hooks for Luna's Work, in use: makePlan from a given card list
// (ctx.cards) and the once-per-plan run-settled callback (ctx.onRunSettled).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createOrchestra } = require('../src/orchestra.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

const TODOS = [
  { at: 1, text: 'one', done: false },
  { at: 2, text: 'two', done: false, details: 'stored details' },
  { at: 3, text: 'three', done: true },
  { at: 4, text: 'mine', done: false, manual: true },
  { at: 5, text: 'five', done: false },
];

function setup({ packages = [pkg('a', [1])], extraDeps = {} } = {}) {
  let seq = 0;
  const log = { planned: [], events: [], lines: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => TODOS,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async ({ openTodos }) => {
      log.planned.push(openTodos);
      return { ok: true, raw: { packages, notes: 'n' }, costUsd: 0 };
    },
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    sessionAlive: (id) => alive.has(id),
    writePty: (id) => alive.has(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    createPr: async () => ({ ok: true, url: 'https://github.com/o/r/pull/1' }),
    removeWorktree: async () => ({ ok: true }),
    sleep: async () => {},
    onRunEvent: (kind) => log.events.push(kind),
    log: (line) => log.lines.push(line),
    ...extraDeps,
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { orch, log, ctx, flush };
}

/** Plans with `extraCtx`, launches, and lets package a finish: the run settles. */
async function settledRun(extraCtx, opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan({ ...s.ctx, ...extraCtx });
  await s.orch.launch({ planId: plan.id });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  return { ...s, planId: plan.id };
}

// ---- Hook A: a plan from a given card list ----------------------------------

test('cards: ids plan exactly those open cards, in the given order, once each', async () => {
  const s = setup();
  const res = await s.orch.makePlan({ ...s.ctx, cards: [5, 1, 5, 99, 3, 4] });
  assert.equal(res.ok, true);
  assert.deepEqual(s.log.planned, [[TODOS[4], TODOS[0]]], 'unknown, done and manual cards are dropped');
});

test('cards: a given card object overrides the stored card, keyed by its at', async () => {
  const s = setup({ packages: [pkg('a', [2])] });
  const res = await s.orch.makePlan({ ...s.ctx, cards: [{ at: 2, text: '', details: 'BRIEF\n\nstored details' }] });
  assert.equal(res.ok, true);
  assert.deepEqual(s.log.planned[0], [{ at: 2, text: 'two', done: false, details: 'BRIEF\n\nstored details' }]);
  assert.deepEqual(res.plan.packages[0].todos, ['two']);
});

test('cards: cards beat todoAts; nothing usable is refused like an empty pick', async () => {
  const s = setup();
  await s.orch.makePlan({ ...s.ctx, cards: [1], todoAts: [5] });
  assert.deepEqual(s.log.planned, [[TODOS[0]]]);
  assert.deepEqual(await s.orch.makePlan({ ...s.ctx, cards: [3, 4, { at: 'x' }, null] }), { ok: false, error: 'noneSelected' });
  assert.deepEqual(await s.orch.makePlan({ ...s.ctx, cards: [] }), { ok: false, error: 'noneSelected' });
});

// ---- Hook B: onRunSettled ---------------------------------------------------

test('onRunSettled fires once with the integration result when the run settles', async () => {
  const calls = [];
  const s = await settledRun({ onRunSettled: (r) => calls.push(r) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].planId, s.planId);
  assert.equal(calls[0].killed, false);
  assert.equal(calls[0].integration.state, 'done');
  assert.deepEqual(calls[0].plan.packages.map((p) => p.state), ['pushed']);

  // Further idle signals (Finish run by hand, a stray tab close) never repeat it.
  assert.equal((await s.orch.finishRun({ planId: s.planId })).ok, true);
  s.orch.onSessionClosed('s1');
  await s.flush();
  assert.equal(calls.length, 1);
});

test('onRunSettled fires for a run stopped and finished by hand', async () => {
  const calls = [];
  const s = setup();
  const { plan } = await s.orch.makePlan({ ...s.ctx, onRunSettled: (r) => calls.push(r) });
  await s.orch.launch({ planId: plan.id });
  assert.equal(s.orch.kill(), true);
  assert.equal(calls.length, 0, 'a kill alone does not settle the integration');
  await s.orch.finishRun({ planId: plan.id });
  await s.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].killed, true);
});

test('onRunSettled belongs to its plan: a replan without it drops it', async () => {
  const calls = [];
  const s = setup();
  await s.orch.makePlan({ ...s.ctx, onRunSettled: (r) => calls.push(r) });
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.orch.view().integration.state, 'done');
  assert.equal(calls.length, 0);
});

test('a throwing or rejecting onRunSettled is logged and never breaks God Mode', async () => {
  const thrown = await settledRun({
    onRunSettled: () => {
      throw new Error('boom');
    },
  });
  assert.equal(thrown.orch.view().integration.state, 'done');
  assert.deepEqual(thrown.log.events, ['done', 'finalized']);
  assert.ok(thrown.log.lines.some((l) => /onRunSettled failed: boom/.test(l)));

  const rejected = await settledRun({ onRunSettled: async () => Promise.reject(new Error('later')) });
  await rejected.flush();
  assert.ok(rejected.log.lines.some((l) => /onRunSettled failed: later/.test(l)));
  assert.equal((await rejected.orch.finishRun({ planId: rejected.planId })).ok, true);
});
