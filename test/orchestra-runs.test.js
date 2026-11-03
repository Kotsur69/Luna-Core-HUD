// ============================================================================
// LunaCore - God Mode board with a project switcher (MULTI_GODMODE_PLAN.md A4)
// ----------------------------------------------------------------------------
// The pure run rules (renderer orchestraRuns.js): chip states, the default
// board project, live updates by projectId. Then the board state module
// (orchestraBoard.js) against a fake window.lunacore: two runs, the board
// follows the active tab, an update for one project never touches another.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runs = require('../src/renderer/modules/orchestraRuns.js');

const entry = (projectId, extra = {}) => ({
  projectId,
  label: projectId ? projectId.toUpperCase() : null,
  planId: `p${projectId || 'none'}`,
  started: true,
  killed: false,
  settled: false,
  pausedUntil: null,
  scheduledAt: null,
  tally: { launched: 1, pending: 1 },
  integration: null,
  ...extra,
});

test('summarize: one chip per project with its state, label and tally', () => {
  const chips = runs.summarize([
    entry('alpha'),
    entry('beta', { pausedUntil: 5000 }),
    entry('gamma', { started: false, scheduledAt: 9000 }),
    entry('delta', { started: false }),
    entry('eps', { settled: true, tally: { pushed: 3 }, integration: 'done' }),
    entry('zeta', { settled: true, tally: { pushed: 2, stalled: 1 } }),
    entry('eta', { tally: { launched: 1, stalled: 1 } }),
    entry('theta', { killed: true }),
  ]);
  assert.deepEqual(
    chips.map((c) => [c.projectId, c.state]),
    [
      ['alpha', 'running'],
      ['beta', 'paused'],
      ['gamma', 'scheduled'],
      ['delta', 'planned'],
      ['eps', 'settled'],
      ['zeta', 'needsYou'],
      ['eta', 'needsYou'],
      ['theta', 'needsYou'],
    ],
  );
  assert.equal(chips[0].label, 'ALPHA');
  assert.equal(chips[1].pausedUntil, 5000);
  assert.deepEqual(chips[0].tally, { launched: 1, pending: 1 });
});

test('summarize: a settled run whose integration failed needs Mati', () => {
  const [chip] = runs.summarize([entry('a', { settled: true, tally: { pushed: 2 }, integration: 'failed' })]);
  assert.equal(chip.state, 'needsYou');
});

test('summarize: bad input is dropped, duplicates keep the first, null project is its own run', () => {
  const chips = runs.summarize([null, 7, [], entry('a'), entry('a', { started: false }), entry(null)]);
  assert.deepEqual(chips.map((c) => [c.projectId, c.state]), [['a', 'running'], [null, 'running']]);
  assert.deepEqual(runs.summarize('nope'), []);
  const [odd] = runs.summarize([{ projectId: 'x', started: true, tally: { pushed: 'x', launched: -1 } }]);
  assert.deepEqual(odd.tally, {});
  assert.equal(odd.label, null);
});

test("defaultBoardProject: the active tab's project first, else the first live run", () => {
  const chips = runs.summarize([
    entry('done', { settled: true, tally: { pushed: 1 }, integration: 'done' }),
    entry('stuck', { killed: true }),
    entry('live'),
  ]);
  assert.equal(runs.defaultBoardProject(chips, 'stuck'), 'stuck');
  assert.equal(runs.defaultBoardProject(chips, 'other'), 'live');
  assert.equal(runs.defaultBoardProject(chips.slice(0, 2), 'other'), 'stuck', 'then a run needing Mati');
  assert.equal(runs.defaultBoardProject(chips.slice(0, 1), 'other'), 'done', 'then any run');
  assert.equal(runs.defaultBoardProject([], 'other'), 'other', 'no runs: the tab, to plan it');
  assert.equal(runs.defaultBoardProject([], undefined), null);
});

test('keepBoardProject: stays while the run exists or is the tab being planned', () => {
  const chips = runs.summarize([entry('a'), entry('b')]);
  assert.equal(runs.keepBoardProject(chips, 'b', 'a'), 'b');
  assert.equal(runs.keepBoardProject(chips, 'gone', 'a'), 'a');
  assert.equal(runs.keepBoardProject(chips, 'c', 'c'), 'c');
  assert.equal(runs.keepBoardProject(chips, undefined, 'b'), 'b');
});

test('entryFromView + upsertEntry: a live update re-derives only its own chip', () => {
  const list = [entry('a'), entry('b')];
  const view = { id: 'pb2', started: true, settled: true, killed: false, tally: { pushed: 2 }, integration: { state: 'done', running: true } };
  const next = runs.upsertEntry(list, 'b', runs.entryFromView('b', view, 'B'));
  assert.deepEqual(next.map((e) => e.projectId), ['a', 'b'], 'order kept');
  assert.equal(next[0], list[0], 'the other run is untouched');
  assert.deepEqual(runs.summarize(next).map((c) => c.state), ['running', 'settled']);
  assert.deepEqual(runs.upsertEntry(next, 'a', null).map((e) => e.projectId), ['b']);
  assert.deepEqual(runs.upsertEntry(next, 'c', runs.entryFromView('c', view, null)).map((e) => e.projectId), ['a', 'b', 'c']);
  assert.equal(runs.entryFromView('c', null, null), null);
  assert.equal(list.length, 2, 'the input list is not mutated');
});

// ---- the board state module ------------------------------------------------

function fakeBridge({ list, views, activeProject }) {
  const calls = [];
  const sessions = [
    { id: 's-alpha', projectId: 'alpha' },
    { id: 's-beta', projectId: 'beta' },
    { id: 's-new', projectId: 'gamma' },
  ];
  const state = { active: sessions.find((s) => s.projectId === activeProject).id };
  globalThis.window = {
    lunacore: {
      getSessions: async () => ({ sessions, activeSessionId: state.active }),
      getProjects: async () => ({ projects: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }, { id: 'gamma', label: 'Gamma' }] }),
      listOrchestra: async () => list,
      getOrchestra: async (projectId) => (calls.push(projectId), views[projectId] || null),
    },
  };
  return { calls, setActive: (projectId) => (state.active = sessions.find((s) => s.projectId === projectId).id) };
}

const fullView = (id, projectId, extra = {}) => ({ id, projectId, started: true, killed: false, settled: false, tally: { launched: 1 }, ...extra });

test('board: two runs give two chips; opening from a tab shows that tab\'s project', async () => {
  const board = await import('../src/renderer/modules/orchestraBoard.js');
  const views = { alpha: fullView('pa', 'alpha'), beta: fullView('pb', 'beta', { pausedUntil: 1000 }) };
  const list = [entry('alpha', { label: 'Alpha', planId: 'pa' }), entry('beta', { label: 'Beta', planId: 'pb', pausedUntil: 1000 })];
  const bridge = fakeBridge({ list, views, activeProject: 'beta' });

  await board.refresh({ reset: true });
  assert.deepEqual(bridge.calls.sort(), ['alpha', 'beta'], 'one orchestra:get per project');
  assert.equal(board.project(), 'beta');
  assert.equal(board.view().id, 'pb');
  assert.deepEqual(board.chips().map((c) => [c.label, c.state]), [['Alpha', 'running'], ['Beta', 'paused']]);

  // Mati picks Alpha on the switcher; an update for Beta leaves the board on Alpha.
  board.select('alpha');
  board.apply(fullView('pb', 'beta', { settled: true, tally: { pushed: 1 } }), 'beta');
  assert.equal(board.project(), 'alpha');
  assert.equal(board.view().id, 'pa');
  assert.equal(board.chips()[1].state, 'settled');

  // Reopened from the Alpha tab, it shows Alpha; from a tab with no run, the
  // first live run - and a 'none' chip to plan that tab's project.
  bridge.setActive('gamma');
  await board.refresh({ reset: true });
  assert.equal(board.project(), 'alpha');
  assert.equal(board.onActiveProject(), false);
  const chips = board.chips();
  assert.deepEqual(chips.map((c) => [c.projectId, c.state]), [['alpha', 'running'], ['beta', 'paused'], ['gamma', 'none']]);
  assert.equal(chips[2].label, 'Gamma');

  // A discard (null view) drops the run; the board falls back to the default.
  board.apply(null, 'alpha');
  assert.equal(board.project(), 'beta');
  assert.deepEqual(board.chips().map((c) => c.projectId), ['beta', 'gamma']);
  delete globalThis.window;
});

test('board: no runs at all -> the active tab, nothing to switch', async () => {
  const board = await import('../src/renderer/modules/orchestraBoard.js');
  fakeBridge({ list: [], views: {}, activeProject: 'alpha' });
  await board.refresh({ reset: true });
  assert.equal(board.project(), 'alpha');
  assert.equal(board.view(), null);
  assert.deepEqual(board.chips(), []);
  // A plan made on that tab lands on the board.
  board.apply(fullView('pn', 'alpha', { started: false }));
  assert.equal(board.view().id, 'pn');
  assert.deepEqual(board.chips().map((c) => c.state), ['planned']);
  delete globalThis.window;
});

test('board: an update or a chip click during a refresh wins over the older fetch', async () => {
  const board = await import('../src/renderer/modules/orchestraBoard.js');
  const views = { alpha: fullView('pa', 'alpha'), beta: fullView('pb', 'beta') };
  const list = [entry('alpha', { planId: 'pa' }), entry('beta', { planId: 'pb' })];
  fakeBridge({ list, views, activeProject: 'alpha' });
  let release;
  const gate = new Promise((r) => (release = r));
  const slowGet = window.lunacore.getOrchestra;
  window.lunacore.getOrchestra = async (projectId) => (await gate, slowGet(projectId));

  const pending = board.refresh({ reset: true });
  await new Promise((r) => setImmediate(r));
  board.apply(fullView('pa', 'alpha', { settled: true, tally: { pushed: 1 } }), 'alpha');
  board.select('beta');
  release();
  await pending;

  assert.equal(board.project(), 'beta', 'the chip clicked meanwhile stays');
  board.select('alpha');
  assert.equal(board.view().settled, true, 'the newer pushed view is kept');
  assert.equal(board.chips()[0].state, 'settled');
  delete globalThis.window;
});
