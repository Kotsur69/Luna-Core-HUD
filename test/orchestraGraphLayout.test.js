'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { layoutGraph, NODE_W, NODE_H } = require('../src/renderer/modules/orchestraGraphLayout.js');
const { buildGraph } = require('../src/renderer/modules/orchestraGraphModel.js');

const pkg = (id, dependsOn = []) => ({ id, title: id, state: 'pending', dependsOn });
const graphOf = (packages) => buildGraph({ packages }, { now: 0 });

function assertNoOverlap(layout) {
  const ns = layout.nodes;
  for (let i = 0; i < ns.length; i += 1) {
    for (let j = i + 1; j < ns.length; j += 1) {
      const a = ns[i];
      const b = ns[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
}

const DIAMOND = [pkg('a'), pkg('b', ['a']), pkg('c', ['a']), pkg('d', ['b', 'c']), pkg('e')];

test('layers follow dependency depth (LR: columns)', () => {
  const l = layoutGraph(graphOf(DIAMOND));
  const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.equal(at.a.layer, 0);
  assert.equal(at.e.layer, 0);
  assert.equal(at.b.layer, 1);
  assert.equal(at.c.layer, 1);
  assert.equal(at.d.layer, 2);
  assert.ok(at.a.x < at.b.x && at.b.x < at.d.x);
  assert.equal(at.b.x, at.c.x);
  assert.equal(at.a.w, NODE_W);
  assert.equal(at.a.h, NODE_H);
  assert.equal(l.direction, 'LR');
  assertNoOverlap(l);
});

test('TB puts layers in rows', () => {
  const l = layoutGraph(graphOf(DIAMOND), { direction: 'TB' });
  const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.ok(at.a.y < at.b.y && at.b.y < at.d.y);
  assert.equal(at.b.y, at.c.y);
  assert.equal(l.direction, 'TB');
  assertNoOverlap(l);
  // Edges leave the bottom of the source and enter the top of the target.
  const e = l.edges.find((x) => x.from === 'a' && x.to === 'b');
  assert.deepEqual(e.points, [[at.a.x + at.a.w / 2, at.a.y + at.a.h], [at.b.x + at.b.w / 2, at.b.y]]);
});

test('deterministic: same graph, same layout', () => {
  const a = layoutGraph(graphOf(DIAMOND));
  const b = layoutGraph(graphOf(DIAMOND));
  assert.deepEqual(a, b);
});

test('barycentric ordering untangles a crossing', () => {
  // x1 feeds y2, x2 feeds y1: input order would cross.
  const l = layoutGraph(graphOf([pkg('x1'), pkg('x2'), pkg('y1', ['x2']), pkg('y2', ['x1'])]));
  const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.equal(at.x1.y < at.x2.y, at.y2.y < at.y1.y);
});

test('cycles are placed without hanging and flagged as back edges', () => {
  const g = graphOf([pkg('a', ['c']), pkg('b', ['a']), pkg('c', ['b']), pkg('s', ['s']), pkg('z', ['a'])]);
  const l = layoutGraph(g);
  assert.equal(l.nodes.length, 5);
  assertNoOverlap(l);
  assert.ok(l.edges.some((e) => e.back));
  assert.ok(l.edges.find((e) => e.from === 's').back);
});

test('ghost nodes of missing deps get placed too', () => {
  const l = layoutGraph(graphOf([pkg('a', ['ghost'])]));
  assert.deepEqual(l.order, ['ghost', 'a']);
  assert.equal(l.edges[0].kind, 'missing');
});

test('empty and junk input', () => {
  assert.deepEqual(layoutGraph(null), { nodes: [], edges: [], order: [], width: 0, height: 0, direction: 'LR' });
  const l = layoutGraph({ nodes: [{ id: 'a' }, { id: 'a' }, null, { id: 7 }], edges: [{ from: 'a', to: 'nope' }, null] });
  assert.equal(l.nodes.length, 1);
  assert.equal(l.edges.length, 0);
});

test('a big graph stays overlap-free and quick', () => {
  const list = [];
  for (let i = 0; i < 200; i += 1) list.push(pkg(`p${i}`, i ? [`p${Math.floor(i / 3)}`] : []));
  const started = Date.now();
  const l = layoutGraph(graphOf(list));
  assert.ok(Date.now() - started < 2000);
  assert.equal(l.order.length, 200);
  assertNoOverlap(l);
});
