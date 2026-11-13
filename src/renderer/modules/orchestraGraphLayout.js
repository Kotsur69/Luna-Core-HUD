// ============================================================================
// LunaCore - God Mode package graph: layered DAG layout (pure)
// ----------------------------------------------------------------------------
// A small Sugiyama-style layout for the graph orchestraGraphModel.js builds:
//   1. back edges (the ones that close a cycle) are found by a DFS in input
//      order and ignored for layering, so a cycle is placed, never looped on;
//   2. every node goes one layer past its deepest dependency;
//   3. a few barycentric sweeps (down, then up) order each layer to cut
//      crossings, ties broken by the previous order, then the id;
//   4. layers become columns (LR) or rows (TB) on a fixed grid, so no two
//      nodes can overlap.
// No randomness, no Date: the same graph always gives the same layout.
// No DOM: node --test imports it directly.
// ============================================================================

'use strict';

export const NODE_W = 196;
export const NODE_H = 64;
export const GAP_LAYER = 72;
export const GAP_NODE = 22;
const SWEEPS = 4;

/**
 * Edges that close a cycle (iterative DFS over dependency -> dependent, input order).
 * @returns {Set<number>} indexes into `edges`
 */
function backEdges(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(i);
  });
  const color = new Map();
  const back = new Set();
  for (const start of ids) {
    if (color.has(start)) continue;
    color.set(start, 1);
    const work = [{ id: start, k: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const list = out.get(frame.id);
      if (frame.k >= list.length) {
        color.set(frame.id, 2);
        work.pop();
        continue;
      }
      const ei = list[frame.k];
      frame.k += 1;
      const next = edges[ei].to;
      const c = color.get(next);
      if (c === 1) back.add(ei);
      else if (!c) {
        color.set(next, 1);
        work.push({ id: next, k: 0 });
      }
    }
  }
  return back;
}

/** Layer of each node: longest path from a source over the forward edges (Kahn order). */
function layersOf(ids, edges, back) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const succ = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (back.has(i) || !indeg.has(e.from) || !indeg.has(e.to) || e.from === e.to) return;
    succ.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  });
  const layer = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let qi = 0; qi < queue.length; qi += 1) {
    const id = queue[qi];
    for (const next of succ.get(id)) {
      layer.set(next, Math.max(layer.get(next), layer.get(id) + 1));
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return layer;
}

/** One barycentric pass: reorders `layers[i]` by the mean position of its neighbours in `layers[ref]`. */
function reorder(layer, neighbours, refPos, rank) {
  const keyed = layer.map((id, i) => {
    const ns = (neighbours.get(id) || []).filter((n) => refPos.has(n));
    const bary = ns.length ? ns.reduce((s, n) => s + refPos.get(n), 0) / ns.length : i;
    return { id, bary, i };
  });
  keyed.sort((a, b) => a.bary - b.bary || a.i - b.i || rank.get(a.id) - rank.get(b.id));
  return keyed.map((k) => k.id);
}

/**
 * Lays the graph out.
 * @param {{nodes: Array<{id:string}>, edges: Array<{from:string, to:string, kind?:string}>}} graph
 * @param {{direction?: 'LR'|'TB', nodeW?: number, nodeH?: number, gapLayer?: number, gapNode?: number}} [opts]
 * @returns {{nodes: Array<{id:string, x:number, y:number, w:number, h:number, layer:number, order:number}>,
 *   edges: Array<{from:string, to:string, kind:string, back:boolean, points:number[][]}>,
 *   order: string[], width: number, height: number, direction: 'LR'|'TB'}}
 */
export function layoutGraph(graph, opts = {}) {
  const direction = opts.direction === 'TB' ? 'TB' : 'LR';
  const w = opts.nodeW || NODE_W;
  const h = opts.nodeH || NODE_H;
  const gapLayer = Number.isFinite(opts.gapLayer) ? opts.gapLayer : GAP_LAYER;
  const gapNode = Number.isFinite(opts.gapNode) ? opts.gapNode : GAP_NODE;
  const seen = new Set();
  const ids = [];
  for (const n of (graph && Array.isArray(graph.nodes) ? graph.nodes : [])) {
    if (n && typeof n.id === 'string' && !seen.has(n.id)) {
      seen.add(n.id);
      ids.push(n.id);
    }
  }
  const edges = (graph && Array.isArray(graph.edges) ? graph.edges : []).filter((e) => e && seen.has(e.from) && seen.has(e.to));
  const rank = new Map(ids.map((id, i) => [id, i]));
  const back = backEdges(ids, edges);
  const layerOf = layersOf(ids, edges, back);

  // reduce, not Math.max(...): a spread of a huge graph overflows the argument limit.
  const layerCount = ids.length ? [...layerOf.values()].reduce((m, l) => Math.max(m, l), 0) + 1 : 0;
  let layers = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layerOf.get(id)].push(id);

  const preds = new Map();
  const succs = new Map();
  edges.forEach((e, i) => {
    if (back.has(i) || e.from === e.to) return;
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e.to);
  });
  const posMap = (layer) => new Map(layer.map((id, i) => [id, i]));
  for (let s = 0; s < SWEEPS; s += 1) {
    const down = s % 2 === 0;
    const next = layers.map((l) => [...l]);
    if (down) for (let i = 1; i < next.length; i += 1) next[i] = reorder(next[i], preds, posMap(next[i - 1]), rank);
    else for (let i = next.length - 2; i >= 0; i -= 1) next[i] = reorder(next[i], succs, posMap(next[i + 1]), rank);
    layers = next;
  }

  const widest = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const stepLayer = (direction === 'LR' ? w : h) + gapLayer;
  const stepNode = (direction === 'LR' ? h : w) + gapNode;
  const placed = new Map();
  const order = [];
  layers.forEach((layer, li) => {
    const offset = ((widest - layer.length) * stepNode) / 2;
    layer.forEach((id, oi) => {
      const along = li * stepLayer;
      const across = offset + oi * stepNode;
      const x = direction === 'LR' ? along : across;
      const y = direction === 'LR' ? across : along;
      placed.set(id, { id, x, y, w, h, layer: li, order: oi });
      order.push(id);
    });
  });

  const anchorOut = (p) => (direction === 'LR' ? [p.x + p.w, p.y + p.h / 2] : [p.x + p.w / 2, p.y + p.h]);
  const anchorIn = (p) => (direction === 'LR' ? [p.x, p.y + p.h / 2] : [p.x + p.w / 2, p.y]);
  const outEdges = edges.map((e, i) => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    const isBack = back.has(i) || e.from === e.to || a.layer >= b.layer;
    return { from: e.from, to: e.to, kind: e.kind || 'dep', back: isBack, points: [anchorOut(a), anchorIn(b)] };
  });
  const along = layerCount ? layerCount * stepLayer - gapLayer : 0;
  const across = widest ? widest * stepNode - gapNode : 0;
  return {
    nodes: order.map((id) => placed.get(id)),
    edges: outEdges,
    order,
    width: direction === 'LR' ? along : across,
    height: direction === 'LR' ? across : along,
    direction,
  };
}
