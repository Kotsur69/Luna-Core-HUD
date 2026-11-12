'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGraph, upstream, downstream, rootBlockers, criticalPath, tallyGraph, LONG_RUN_MS,
} = require('../src/renderer/modules/orchestraGraphModel.js');

const NOW = 1_800_000_000_000;
const pkg = (id, extra = {}) => ({ id, title: `T ${id}`, state: 'pending', dependsOn: [], ...extra });
const view = (packages) => ({ id: 'plan-1', projectId: 'p', packages });
const node = (g, id) => g.nodes.find((n) => n.id === id);

test('normalization: bad shapes never throw', () => {
  assert.deepEqual(buildGraph(null).nodes, []);
  assert.equal(buildGraph(null).malformed, false);
  assert.equal(buildGraph(undefined).malformed, false);
  assert.equal(buildGraph('junk').malformed, true);
  const noList = buildGraph({ id: 'x' });
  assert.equal(noList.malformed, true);
  assert.deepEqual(noList.warnings, [{ code: 'badShape' }]);
  const g = buildGraph(view([null, 7, { title: 'no id' }, pkg('a', { dependsOn: 'b', state: 'weird', title: '' }), pkg('a')]), { now: NOW });
  assert.equal(g.nodes.length, 1);
  assert.equal(node(g, 'a').title, 'a');
  assert.equal(node(g, 'a').state, 'pending');
  assert.deepEqual(node(g, 'a').dependsOn, []);
  const codes = g.warnings.map((w) => w.code);
  assert.deepEqual(codes, ['badPackage', 'badPackage', 'badPackage', 'badState', 'duplicateId']);
});

test('the input view is never mutated', () => {
  const v = view([pkg('a'), pkg('b', { dependsOn: ['a', 'ghost'] })]);
  const before = JSON.stringify(v);
  Object.freeze(v);
  v.packages.forEach((p) => { Object.freeze(p); Object.freeze(p.dependsOn); });
  buildGraph(v, { now: NOW });
  assert.equal(JSON.stringify(v), before);
});

test('derived visuals: merged, pushed, ready, waiting, active, long-stalled', () => {
  const g = buildGraph(view([
    pkg('m', { state: 'pushed', merged: true }),
    pkg('p', { state: 'pushed' }),
    pkg('r', { dependsOn: ['m', 'p'] }),
    pkg('w', { dependsOn: ['act'] }),
    pkg('act', { state: 'launched', startedAt: NOW - 1000 }),
    pkg('long', { state: 'launched', startedAt: NOW - LONG_RUN_MS - 1 }),
    pkg('st', { state: 'stalled', startedAt: NOW - 5000 }),
    pkg('fin', { state: 'finishing', verifyPhase: 'queued' }),
  ]), { now: NOW });
  const vis = Object.fromEntries(g.nodes.map((n) => [n.id, n.visual]));
  assert.deepEqual(vis, { m: 'merged', p: 'pushed', r: 'ready', w: 'waiting', act: 'active', long: 'longStalled', st: 'longStalled', fin: 'active' });
  assert.equal(node(g, 'act').elapsedMs, 1000);
  assert.equal(node(g, 'fin').stateKey, 'waitingVerify');
  assert.equal(node(g, 'fin').flags.waitingVerify, true);
});

test('blocked: blockedBy, awaitingDeps, failed / killed / terminal dependency', () => {
  const g = buildGraph(view([
    pkg('f', { state: 'failed', error: 'conflict' }),
    pkg('k', { state: 'killed' }),
    pkg('t', { state: 'stalled', terminal: true }),
    pkg('b1', { dependsOn: ['f'] }),
    pkg('b2', { dependsOn: ['k'] }),
    pkg('b3', { dependsOn: ['t'] }),
    pkg('b4', { dependsOn: ['b1'], blockedBy: 'f' }),
    pkg('aw', { state: 'launched', awaitingDeps: true, dependsOn: ['b1'] }),
  ]), { now: NOW });
  for (const id of ['b1', 'b2', 'b3', 'b4', 'aw']) assert.equal(node(g, id).visual, 'blocked', id);
  assert.equal(node(g, 'b1').waitingOn, 'f');
  assert.equal(node(g, 'b4').waitingOn, 'f');
  assert.equal(node(g, 'aw').waitingOn, 'b1');
  assert.equal(node(g, 'f').error, 'conflict');
});

test('rootBlockers follows the blocked chain to the failed root', () => {
  const g = buildGraph(view([
    pkg('root', { state: 'failed' }),
    pkg('mid', { dependsOn: ['root'] }),
    pkg('leaf', { dependsOn: ['mid'], blockedBy: 'root' }),
    pkg('fine', { state: 'pushed' }),
  ]), { now: NOW });
  assert.deepEqual(rootBlockers(g, 'mid'), ['mid', 'root']);
  assert.deepEqual(rootBlockers(g, 'leaf'), ['leaf', 'root']);
  assert.deepEqual(rootBlockers(g, 'fine'), []);
  assert.deepEqual(rootBlockers(g, 'nope'), []);
  const stalledRoot = buildGraph(view([pkg('s', { state: 'stalled', terminal: true }), pkg('x', { dependsOn: ['s'] })]), { now: NOW });
  assert.deepEqual(rootBlockers(stalledRoot, 'x'), ['x', 's']);
});

test('recover ask flag comes from the stall history', () => {
  const g = buildGraph(view([pkg('a', { state: 'stalled', stallHistory: [{ kind: 'ask', reason: 'network' }] })]), { now: NOW });
  assert.deepEqual(node(g, 'a').flags.recoverAsk, { key: 'orch.recover.ask.network', cause: 'network' });
});

test('missing dependencies: ghost node, missing edge, warning', () => {
  const g = buildGraph(view([pkg('a', { dependsOn: ['zz'] }), pkg('b', { dependsOn: ['zz'] })]), { now: NOW });
  const ghost = node(g, 'zz');
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.visual, 'missing');
  assert.equal(g.nodes.filter((n) => n.ghost).length, 1);
  assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.kind]), [['zz', 'a', 'missing'], ['zz', 'b', 'missing']]);
  assert.deepEqual(g.warnings.filter((w) => w.code === 'missingDep').map((w) => w.id), ['a', 'b']);
  assert.equal(node(g, 'a').visual, 'waiting');
});

test('cycles are reported, never thrown, and marked on edges', () => {
  const g = buildGraph(view([
    pkg('a', { dependsOn: ['c'] }), pkg('b', { dependsOn: ['a'] }), pkg('c', { dependsOn: ['b'] }),
    pkg('self', { dependsOn: ['self'] }), pkg('out', { dependsOn: ['a'] }),
  ]), { now: NOW });
  assert.deepEqual(g.cycles, [['a', 'b', 'c'], ['self']]);
  assert.equal(g.warnings.filter((w) => w.code === 'cycle').length, 2);
  assert.equal(g.edges.find((e) => e.from === 'a' && e.to === 'out').inCycle, false);
  assert.equal(g.edges.find((e) => e.from === 'a' && e.to === 'b').inCycle, true);
  assert.equal(node(g, 'a').flags.inCycle, true);
  // Helpers terminate on cycles too.
  assert.deepEqual(upstream(g, 'a'), ['c', 'b']);
  assert.deepEqual(downstream(g, 'a'), ['b', 'out', 'c']);
  assert.deepEqual(criticalPath(g).ids, ['out']);
});

test('a long chain of cycles does not blow the stack', () => {
  const list = [];
  for (let i = 0; i < 3000; i += 1) list.push(pkg(`n${i}`, { dependsOn: [`n${(i + 1) % 3000}`] }));
  const g = buildGraph(view(list), { now: NOW });
  assert.equal(g.cycles.length, 1);
  assert.equal(g.cycles[0].length, 3000);
});

test('criticalPath on a very long chain does not overflow the stack', () => {
  const list = [];
  for (let i = 0; i < 20000; i += 1) list.push(pkg(`c${i}`, { dependsOn: i ? [`c${i - 1}`] : [] }));
  const path = criticalPath(buildGraph(view(list), { now: NOW }));
  assert.equal(path.ids.length, 20000);
  assert.equal(path.ids[0], 'c0');
});

test('upstream / downstream', () => {
  const g = buildGraph(view([pkg('a'), pkg('b', { dependsOn: ['a'] }), pkg('c', { dependsOn: ['b'] }), pkg('d', { dependsOn: ['a'] })]), { now: NOW });
  assert.deepEqual(upstream(g, 'c'), ['b', 'a']);
  assert.deepEqual(downstream(g, 'a'), ['b', 'd', 'c']);
  assert.deepEqual(downstream(g, 'c'), []);
  assert.deepEqual(upstream(null, 'x'), []);
});

test('criticalPath: longest unfinished chain, estimates else 1', () => {
  const g = buildGraph(view([
    pkg('done', { state: 'pushed' }),
    pkg('a', { dependsOn: ['done'] }),
    pkg('b', { dependsOn: ['a'] }),
    pkg('c', { dependsOn: ['b'] }),
    pkg('big', { estimateMinutes: 10 }),
  ]), { now: NOW });
  assert.deepEqual(criticalPath(g), { ids: ['big'], minutes: 10 });
  const flat = buildGraph(view([pkg('a'), pkg('b', { dependsOn: ['a'] }), pkg('c', { dependsOn: ['b'] }), pkg('x')]), { now: NOW });
  assert.deepEqual(criticalPath(flat), { ids: ['a', 'b', 'c'], minutes: 3 });
  assert.deepEqual(criticalPath(buildGraph(null)), { ids: [], minutes: 0 });
});

test('tallyGraph counts states and visuals, ghosts left out', () => {
  const g = buildGraph(view([pkg('a', { state: 'pushed' }), pkg('b', { state: 'failed', dependsOn: ['q'] })]), { now: NOW });
  const t = tallyGraph(g);
  assert.deepEqual(t.byState, { pushed: 1, failed: 1 });
  assert.deepEqual(t.byVisual, { pushed: 1, failed: 1 });
});
