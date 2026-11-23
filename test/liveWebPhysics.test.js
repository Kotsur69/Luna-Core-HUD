// ============================================================================
// God Mode Live Web: the force-directed layout (src/renderer/modules/liveWebPhysics.js)
// ----------------------------------------------------------------------------
// Pins what the canvas relies on: the same graph always lands in the same
// place (seeded starts, fixed steps), 400 nodes come to rest, nothing ever
// turns NaN - not even for coincident nodes or junk input - and a node keeps
// its place when the graph around it changes.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/renderer/modules/liveWebPhysics.js');

/** A run, `workers` workers on a ring, `leaves` leaves spread over them (some shared). */
function web(workers, leaves) {
  const nodes = [{ id: 'run', fixed: { x: 0, y: 0 } }];
  const edges = [];
  for (let w = 0; w < workers; w += 1) {
    nodes.push({ id: `w${w}`, parent: 'run', ring: 220 });
    edges.push({ from: 'run', to: `w${w}`, length: 200 });
  }
  for (let i = 0; i < leaves; i += 1) {
    const w = i % workers;
    nodes.push({ id: `f${i}`, parent: `w${w}`, ring: 420 });
    edges.push({ from: `w${w}`, to: `f${i}`, length: 80 });
    if (i % 7 === 0) edges.push({ from: `w${(w + 1) % workers}`, to: `f${i}`, length: 80 });
  }
  return { nodes, edges };
}

const allFinite = (sim) => sim.nodes.every((n) => [n.x, n.y, n.vx, n.vy].every(Number.isFinite));
const snapshot = (sim) => sim.nodes.map((n) => [n.id, n.x, n.y]);

test('seeded starts: the same id starts in the same place, whatever else is in the graph', () => {
  assert.equal(P.hashString('w1'), P.hashString('w1'));
  assert.notEqual(P.hashString('w1'), P.hashString('w2'));
  const r1 = P.seededRandom(42);
  const r2 = P.seededRandom(42);
  const a = [r1(), r1(), r1()];
  assert.deepEqual(a, [r2(), r2(), r2()]);
  assert.ok(a.every((v) => v >= 0 && v < 1));

  const one = P.createSim();
  P.setGraph(one, [{ id: 'run', fixed: { x: 0, y: 0 } }, { id: 'w1', parent: 'run', ring: 200 }], []);
  const two = P.createSim();
  P.setGraph(two, [{ id: 'run', fixed: { x: 0, y: 0 } }, { id: 'other', ring: 50 }, { id: 'w1', parent: 'run', ring: 200 }], []);
  assert.deepEqual(P.positionOf(one, 'w1'), P.positionOf(two, 'w1'));
  // Seeded beside its parent, not at the origin.
  const p = P.positionOf(one, 'w1');
  assert.ok(Math.hypot(p.x, p.y) > 0);
});

test('deterministic: two simulations of one graph take identical steps', () => {
  const g = web(6, 40);
  const a = P.createSim();
  const b = P.createSim();
  P.setGraph(a, g.nodes, g.edges);
  P.setGraph(b, g.nodes, g.edges);
  P.step(a, 120);
  P.step(b, 60);
  P.step(b, 60);
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.equal(a.alpha, b.alpha);
});

test('400 nodes come to rest, finite, spread out and around the origin', () => {
  const g = web(20, 379);
  const sim = P.createSim();
  P.setGraph(sim, g.nodes, g.edges);
  assert.equal(sim.nodes.length, 400);
  const steps = P.settle(sim);
  assert.ok(steps <= P.MAX_SETTLE_STEPS, `took ${steps} steps`);
  assert.ok(P.isSettled(sim));
  assert.ok(allFinite(sim));
  assert.ok(P.kineticEnergy(sim) < 0.01, `still moving: ${P.kineticEnergy(sim)}`);
  // The run stays nailed down; nobody sits on anybody.
  assert.deepEqual(P.positionOf(sim, 'run'), { x: 0, y: 0 });
  let minD = Infinity;
  for (let i = 0; i < sim.nodes.length; i += 1) {
    for (let j = i + 1; j < sim.nodes.length; j += 1) {
      minD = Math.min(minD, Math.hypot(sim.nodes[i].x - sim.nodes[j].x, sim.nodes[i].y - sim.nodes[j].y));
    }
  }
  assert.ok(minD > 5, `nodes overlap (closest pair ${minD})`);
  // Layers read as rings: workers sit inside the leaves on average.
  const meanR = (prefix) => {
    const list = sim.nodes.filter((n) => n.id.startsWith(prefix));
    return list.reduce((s, n) => s + Math.hypot(n.x, n.y), 0) / list.length;
  };
  assert.ok(meanR('w') < meanR('f'));
  const b = P.bounds(sim);
  assert.ok(b.minX < 0 && b.maxX > 0 && b.minY < 0 && b.maxY > 0);
});

test('never NaN: coincident nodes, zero-length springs and junk input', () => {
  const sim = P.createSim();
  const nodes = [
    { id: 'a', fixed: { x: 5, y: 5 } },
    { id: 'b', fixed: { x: NaN, y: 1 } },
    { id: 'c', ring: Infinity },
    { id: 'c' },
    null,
    { id: '' },
    { id: 7 },
    { id: 'd', parent: 'missing', ring: -3 },
  ];
  const edges = [
    { from: 'a', to: 'b', length: 0 },
    { from: 'b', to: 'c', length: NaN, strength: -2 },
    { from: 'a', to: 'nope' },
    { from: 'a', to: 'a' },
    null,
  ];
  P.setGraph(sim, nodes, edges);
  assert.deepEqual(sim.nodes.map((n) => n.id), ['a', 'b', 'c', 'd']);
  assert.equal(sim.links.length, 2);
  // Force every free node onto one point: the seeded nudge must part them.
  for (const n of sim.nodes) {
    n.x = 5;
    n.y = 5;
  }
  P.settle(sim);
  assert.ok(allFinite(sim));
  assert.deepEqual(P.positionOf(sim, 'a'), { x: 5, y: 5 });
  assert.notDeepEqual(P.positionOf(sim, 'b'), P.positionOf(sim, 'c'));
  // A node that went non-finite anyway goes back to its seed.
  sim.nodes[1].x = NaN;
  P.reheat(sim, 1);
  P.step(sim, 1);
  assert.ok(allFinite(sim));
  // Empty and junk graphs are fine too.
  const empty = P.createSim();
  P.setGraph(empty, undefined, 'x');
  assert.ok(P.settle(empty) >= 0);
  assert.equal(P.bounds(empty), null);
  assert.equal(P.kineticEnergy(empty), 0);
});

test('a changed graph keeps known nodes in place and reheats; the same graph does not', () => {
  const g = web(4, 12);
  const sim = P.createSim();
  P.setGraph(sim, g.nodes, g.edges);
  P.settle(sim);
  const before = P.positionOf(sim, 'w2');
  assert.equal(P.setGraph(sim, g.nodes, g.edges), false);
  assert.ok(P.isSettled(sim));
  const grown = web(4, 13);
  assert.equal(P.setGraph(sim, grown.nodes, grown.edges), true);
  assert.deepEqual(P.positionOf(sim, 'w2'), before);
  assert.ok(sim.alpha >= P.REHEAT_ALPHA);
  // The new leaf starts beside its worker.
  const leaf = P.positionOf(sim, 'f12');
  const parent = P.positionOf(sim, 'w0');
  assert.ok(Math.hypot(leaf.x - parent.x, leaf.y - parent.y) < 100);
  // An edge-only change counts as a change as well.
  P.settle(sim);
  assert.equal(P.setGraph(sim, grown.nodes, grown.edges.slice(1)), true);
});

test('pin / unpin: a dragged node stays put while held and keeps the web awake', () => {
  const g = web(3, 9);
  const sim = P.createSim();
  P.setGraph(sim, g.nodes, g.edges);
  P.settle(sim);
  assert.equal(P.pin(sim, 'nope', 1, 1), false);
  assert.equal(P.pin(sim, 'w1', NaN, 1), false);
  assert.equal(P.pin(sim, 'w1', 300, -40), true);
  assert.equal(P.isSettled(sim), false);
  P.step(sim, 30);
  assert.deepEqual(P.positionOf(sim, 'w1'), { x: 300, y: -40 });
  assert.equal(P.unpin(sim, 'w1'), true);
  assert.equal(P.unpin(sim, 'nope'), false);
  P.settle(sim);
  assert.ok(P.isSettled(sim));
  assert.ok(allFinite(sim));
});
