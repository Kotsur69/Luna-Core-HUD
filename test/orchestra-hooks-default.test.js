// ============================================================================
// God Mode's default path, pinned. orchestra.js has two optional hooks for
// Luna's Work (makePlan ctx.cards and ctx.onRunSettled); with neither set,
// God Mode must plan the same cards and emit the same events as before them.
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

function setup() {
  let seq = 0;
  const log = { planned: [], events: [], callbacks: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => TODOS,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async ({ openTodos }) => {
      log.planned.push(openTodos);
      return { ok: true, raw: { packages: [pkg('a', [1]), pkg('b', [2, 5], { dependsOn: ['a'] })], notes: 'n' }, costUsd: 0 };
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
    // A deps-level callback of the same name is not a hook: never called.
    onRunSettled: (r) => log.callbacks.push(r),
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { orch, log, ctx, flush };
}

test('default makePlan plans every open, non-manual card in store order', async () => {
  const s = setup();
  const res = await s.orch.makePlan(s.ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(s.log.planned, [[TODOS[0], TODOS[1], TODOS[4]]]);
  assert.deepEqual(res.plan.packages.map((p) => [p.id, p.todos]), [
    ['a', ['one']],
    ['b', ['two', 'five']],
  ]);
});

test('default makePlan keeps the picker selection (todoAts) as before', async () => {
  const s = setup();
  await s.orch.makePlan({ ...s.ctx, todoAts: [5, 1] });
  assert.deepEqual(s.log.planned, [[TODOS[0], TODOS[4]]], 'store order, not pick order');
  assert.deepEqual(await setup().orch.makePlan({ ...s.ctx, todoAts: [3, 4] }), { ok: false, error: 'noneSelected' });
});

test('default run emits the same events and never calls a callback', async () => {
  const s = setup();
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush();
  assert.equal(s.orch.view().integration.state, 'done');
  assert.deepEqual(s.log.events, ['done', 'finalized']);

  // A second finalize (Finish run by hand) adds its own event, nothing else.
  assert.equal((await s.orch.finishRun({ planId: plan.id })).ok, true);
  assert.deepEqual(s.log.events, ['done', 'finalized', 'finalized']);
  assert.deepEqual(s.log.callbacks, []);
});
