// ============================================================================
// The `manual` opt-out flag on a to-do: a card only the user can do. It must
// round-trip through the store, stay out of God Mode's queue and Orchestra's
// planner, be settable through the intake MCP tools, and leave a plain item
// byte-identical when it is not set.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTodo, normalizeCardFields } = require('../src/todo.js');
const { toggleManual } = require('../src/renderer/modules/todo.js');
const { pickNextItem, queueStep, runnableCount, armCounts } = require('../src/renderer/modules/godmode.js');
const { normalizeArmCounts, confirmDetail } = require('../src/godmodeconfirm.js');
const { createOrchestra } = require('../src/orchestra.js');
const { applyAdd, applyUpdate, TOOLS } = require('../src/intake.js');

const item = (at, extra = {}) => ({ text: `t${at}`, done: false, at, ...extra });
const none = new Set();

// ---- data -------------------------------------------------------------------

test('normalizeCardFields keeps manual only when it is exactly true', () => {
  assert.deepEqual(normalizeCardFields({ manual: true }), { manual: true });
  for (const junk of [false, 'true', 1, null, undefined, {}]) {
    assert.deepEqual(normalizeCardFields({ manual: junk }), {}, `manual=${String(junk)} is dropped`);
  }
});

test('a plain item round-trips byte-identical and gains no manual key', () => {
  const plain = { text: 'buy milk', done: false, at: 5 };
  assert.equal(JSON.stringify(normalizeTodo(plain)), JSON.stringify(plain));
  assert.equal('manual' in normalizeTodo({ ...plain, manual: false }), false);
  assert.deepEqual(normalizeTodo({ ...plain, manual: true }), { ...plain, manual: true });
});

test('toggleManual sets and clears the flag by index, never mutating', () => {
  const list = [item(1), item(2, { size: 'S' })];
  const on = toggleManual(list, 1);
  assert.deepEqual(on[1], { ...list[1], manual: true });
  assert.equal(list[1].manual, undefined, 'input untouched');
  assert.equal(on[0], list[0], 'other rows keep their identity');
  const off = toggleManual(on, 1);
  assert.deepEqual(off[1], list[1]);
  assert.equal('manual' in off[1], false, 'cleared means no key, not manual:false');
  assert.equal(toggleManual(list, 9), list, 'out of range is a no-op');
});

// ---- God Mode -----------------------------------------------------------------

test('pickNextItem never takes a manual item', () => {
  const list = [item(1, { manual: true }), item(2)];
  assert.equal(pickNextItem(list, none).at, 2);
  assert.equal(pickNextItem([item(1, { manual: true })], none), null);
});

test('queueStep finishes once only manual items are left open', () => {
  const list = [item(1, { manual: true }), item(2, { done: true }), item(3, { manual: true })];
  assert.deepEqual(queueStep(list, none), { action: 'done' });
  assert.equal(runnableCount(list), 0);
});

test('an item depending on an open manual item waits (the deadlock check stalls it)', () => {
  const list = [item(1, { manual: true }), item(2, { dependsOn: [1] })];
  assert.deepEqual(queueStep(list, none), { action: 'wait' });
  const ticked = [item(1, { manual: true, done: true }), item(2, { dependsOn: [1] })];
  assert.equal(queueStep(ticked, none).item.at, 2, 'ticking the manual item by hand unblocks it');
});

test('runnableCount counts open items the run may take', () => {
  assert.equal(runnableCount([item(1), item(2, { manual: true }), item(3, { done: true })]), 1);
  assert.equal(runnableCount(null), 0);
});

test('armCounts splits open items into runnable, skipped (manual) and blocked by manual', () => {
  const list = [
    item(1, { manual: true }),
    item(2, { dependsOn: [1] }), // blocked directly
    item(3, { dependsOn: [2] }), // blocked through 2
    item(4),
    item(5, { dependsOn: [4] }), // waits on a runnable item: still runnable
    item(6, { manual: true, done: true }),
    item(7, { dependsOn: [6] }), // its manual dependency is done
    item(8, { done: true }),
  ];
  assert.deepEqual(armCounts(list), { runnable: 3, skipped: 1, blocked: 2 });
  assert.deepEqual(armCounts([]), { runnable: 0, skipped: 0, blocked: 0 });
  assert.deepEqual(armCounts([item(1, { manual: true }), item(2, { dependsOn: [1] })]), {
    runnable: 0,
    skipped: 1,
    blocked: 1,
  });
});

test('normalizeArmCounts never trusts the renderer payload', () => {
  assert.deepEqual(normalizeArmCounts({ runnable: 3, skipped: 1, blocked: 2 }), { runnable: 3, skipped: 1, blocked: 2 });
  assert.deepEqual(normalizeArmCounts(null), { runnable: 0, skipped: 0, blocked: 0 });
  assert.deepEqual(normalizeArmCounts(7), { runnable: 0, skipped: 0, blocked: 0 });
  assert.deepEqual(normalizeArmCounts({ runnable: -1, skipped: 2.5, blocked: 'x' }), { runnable: 0, skipped: 0, blocked: 0 });
  assert.deepEqual(normalizeArmCounts({ runnable: 1e9, skipped: Infinity, blocked: NaN }), {
    runnable: 100,
    skipped: 0,
    blocked: 0,
  });
});

test('confirmDetail names all three counts in both languages', () => {
  const counts = { runnable: 3, skipped: 1, blocked: 2 };
  const en = confirmDetail(counts, false);
  assert.match(en, /3 open tasks/);
  assert.match(en, /1 manual/);
  assert.match(en, /2 .*blocked/);
  const pl = confirmDetail(counts, true);
  assert.match(pl, /3 zadania/);
  assert.match(pl, /Pominie 1 .*recznie/);
  assert.match(pl, /2 .*zablokowan/);
  assert.doesNotMatch(pl, /[ąćęłńóśźż]/i, 'no diacritics');
  assert.doesNotMatch(confirmDetail({ runnable: 1, skipped: 0, blocked: 0 }, false), /manual|blocked/);
});

// ---- Orchestra ---------------------------------------------------------------

function orchestraWith(todos, seen) {
  return createOrchestra({
    now: () => 1700000000000,
    readTodos: () => todos,
    dirtyCount: async () => 0,
    runPlanner: async ({ openTodos }) => {
      seen.push(openTodos.map((t) => t.at));
      return {
        ok: true,
        raw: {
          packages: [{ id: 'a', title: 'A', todoAts: openTodos.map((t) => t.at), prompt: 'do', files: [], dependsOn: [], verify: '', model: 'sonnet' }],
          notes: '',
        },
        costUsd: 0,
      };
    },
    addWorktree: async () => ({ ok: false, error: 'unused' }),
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
  });
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test("Orchestra's planner never receives manual items", async () => {
  const seen = [];
  const orch = orchestraWith([item(1), item(2, { manual: true }), item(3)], seen);
  const res = await orch.makePlan(ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [[1, 3]]);
});

test('makePlan returns noTodos when every open item is manual', async () => {
  const seen = [];
  const orch = orchestraWith([item(1, { manual: true }), item(2, { done: true })], seen);
  assert.deepEqual(await orch.makePlan(ctx), { ok: false, error: 'noTodos' });
  assert.deepEqual(seen, [], 'the planner is not even started');
});

// ---- intake MCP --------------------------------------------------------------

test('luna_todo_add and luna_todo_update schemas accept a boolean manual', () => {
  const add = TOOLS.find((t) => t.name === 'luna_todo_add').inputSchema.properties.tasks.items.properties;
  const update = TOOLS.find((t) => t.name === 'luna_todo_update').inputSchema.properties.patch.properties;
  for (const props of [add, update]) {
    assert.equal(props.manual.type, 'boolean');
    assert.match(props.manual.description, /God Mode\/Orchestra/);
  }
});

test('applyAdd stores manual only when true', () => {
  const res = applyAdd([], [{ text: 'call the bank', manual: true }, { text: 'plain' }, { text: 'off', manual: false }], 100);
  assert.equal(res.ok, true);
  assert.equal(res.added[0].manual, true);
  assert.equal('manual' in res.added[1], false);
  assert.equal('manual' in res.added[2], false);
});

test('applyUpdate sets, clears (false or null) and leaves manual alone', () => {
  const list = [{ text: 'x', done: false, at: 1 }];
  const on = applyUpdate(list, 1, { manual: true });
  assert.equal(on.card.manual, true);
  assert.equal(applyUpdate(on.list, 1, { details: 'd' }).card.manual, true, 'an unrelated patch keeps it');
  assert.equal('manual' in applyUpdate(on.list, 1, { manual: false }).card, false);
  assert.equal('manual' in applyUpdate(on.list, 1, { manual: null }).card, false);
});
