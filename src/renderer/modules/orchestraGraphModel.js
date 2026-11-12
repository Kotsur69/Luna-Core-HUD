// ============================================================================
// LunaCore - God Mode package graph: the model (pure)
// ----------------------------------------------------------------------------
// Turns one run view (orchestraBoard.view(), the object main pushes on
// orchestra:changed) into a graph the live map draws:
//   nodes  - one per package, plus a ghost node per unknown dependency id
//   edges  - dependency -> dependent ({from, to, kind: 'dep' | 'missing'})
//   cycles - every dependency cycle (arrays of ids), reported, never thrown
//   warnings - what was odd about the input (missing deps, bad shapes)
// Each node carries a derived `visual` (merged, ready, blocked, long-stalled
// ...) and flags (recover ask, split, waiting to verify).
// The input is never mutated; every array returned is new. No DOM, no
// window: node --test imports it directly, and the Luna's Work tab can embed
// the same graph later.
// ============================================================================

'use strict';

import { pkgStateKey, recoverAsk } from './orchestraState.js';

/** A launched package running longer than this reads as long-stalled. */
export const LONG_RUN_MS = 45 * 60 * 1000;
/** Minutes a package weighs on the critical path when it carries no estimate. */
export const DEFAULT_PATH_MINUTES = 1;

export const PACKAGE_STATES = ['pending', 'launched', 'finishing', 'pushed', 'failed', 'stalled', 'killed', 'closed'];
const KNOWN_STATES = new Set(PACKAGE_STATES);
const ACTIVE_STATES = new Set(['launched', 'finishing']);
// A dependency in one of these will not get pushed without a hand.
const DEAD_STATES = new Set(['failed', 'killed']);
// Where a blocked chain ends: the package that has to be dealt with.
const ROOT_STATES = new Set(['failed', 'stalled', 'killed', 'closed']);

/** Every visual a node can have (the CSS class is `is-<visual>`). */
export const VISUALS = [
  'merged', 'pushed', 'active', 'longStalled', 'failed', 'killed', 'closed', 'blocked', 'ready', 'waiting', 'missing',
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * One package of the view as a plain, safe record; null when it has no id.
 * @param {unknown} raw
 */
function normalizePackage(raw) {
  if (!isObj(raw) || !str(raw.id)) return null;
  const state = KNOWN_STATES.has(raw.state) ? raw.state : 'pending';
  const deps = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d) => str(d)) : [];
  return {
    id: raw.id,
    title: str(raw.title) || raw.id,
    state,
    rawState: typeof raw.state === 'string' ? raw.state : null,
    stateKey: pkgStateKey({ state, verifyPhase: raw.verifyPhase }),
    dependsOn: [...new Set(deps)],
    awaitingDeps: raw.awaitingDeps === true,
    blockedBy: str(raw.blockedBy),
    terminal: raw.terminal === true,
    startedAt: num(raw.startedAt),
    finishedAt: num(raw.finishedAt),
    error: str(raw.error),
    merged: raw.merged === true,
    splitOf: str(raw.splitOf),
    splitInto: Array.isArray(raw.splitInto) ? raw.splitInto.filter((d) => str(d)) : [],
    estimateMinutes: num(raw.estimateMinutes) !== null && raw.estimateMinutes > 0 ? raw.estimateMinutes : null,
  };
}

/** Elapsed time of a package: running so far, or how long it took. */
function elapsedOf(p, now) {
  if (p.startedAt === null) return null;
  if (ACTIVE_STATES.has(p.state) || p.state === 'stalled') return Math.max(0, now - p.startedAt);
  if (p.finishedAt !== null) return Math.max(0, p.finishedAt - p.startedAt);
  return null;
}

/** The dependency a blocked package waits on (for "waiting on <id>"), or null. */
function waitingOnOf(p, byId) {
  if (p.blockedBy) return p.blockedBy;
  const dead = p.dependsOn.find((d) => {
    const dep = byId.get(d);
    return dep && (DEAD_STATES.has(dep.state) || (dep.terminal && dep.state !== 'pushed'));
  });
  if (dead) return dead;
  if (p.awaitingDeps) return p.dependsOn.find((d) => !byId.has(d) || byId.get(d).state !== 'pushed') || null;
  return null;
}

/**
 * The derived visual of a package.
 * @param {object} p normalized package
 * @param {Map<string, object>} byId
 * @param {number} now
 */
function visualOf(p, byId, now) {
  if (p.state === 'pushed') return p.merged ? 'merged' : 'pushed';
  if (p.state === 'failed' || p.state === 'killed' || p.state === 'closed') return p.state;
  if (p.state === 'stalled') return 'longStalled';
  if (p.awaitingDeps) return 'blocked';
  if (ACTIVE_STATES.has(p.state)) {
    return p.state === 'launched' && p.startedAt !== null && now - p.startedAt > LONG_RUN_MS ? 'longStalled' : 'active';
  }
  // pending
  if (waitingOnOf(p, byId)) return 'blocked';
  const allPushed = p.dependsOn.every((d) => byId.has(d) && byId.get(d).state === 'pushed');
  return allPushed ? 'ready' : 'waiting';
}

/** Tarjan's strongly connected components over id -> dependency ids; iterative, never throws. */
function findCycles(order, depsOf) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;
  for (const start of order) {
    if (index.has(start)) continue;
    const work = [{ id: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const deps = depsOf(frame.id);
      if (frame.i < deps.length) {
        const next = deps[frame.i];
        frame.i += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id), index.get(next)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].id;
        low.set(parent, Math.min(low.get(parent), low.get(frame.id)));
      }
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const comp = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        comp.push(member);
      } while (member !== frame.id);
      if (comp.length > 1 || depsOf(frame.id).includes(frame.id)) cycles.push(comp);
    }
  }
  const pos = new Map(order.map((id, i) => [id, i]));
  return cycles.map((c) => [...c].sort((a, b) => pos.get(a) - pos.get(b)));
}

/** Packages of a view that is not an object with a packages array: malformed. */
function packagesOf(view, warnings) {
  if (!isObj(view)) return { list: [], malformed: view !== null && view !== undefined };
  if (!Array.isArray(view.packages)) {
    warnings.push({ code: 'badShape' });
    return { list: [], malformed: true };
  }
  return { list: view.packages, malformed: false };
}

/** Flags shown on a node beside its visual. */
function flagsOf(raw, p, cycleIds) {
  return {
    recoverAsk: recoverAsk(raw),
    waitingVerify: p.stateKey === 'waitingVerify',
    terminal: p.terminal,
    awaitingDeps: p.awaitingDeps,
    splitOf: p.splitOf,
    splitInto: p.splitInto,
    inCycle: cycleIds.has(p.id),
  };
}

/**
 * The graph of one run view.
 * @param {object|null} view
 * @param {{now?: number}} [opts]
 * @returns {{nodes: object[], edges: Array<{from:string, to:string, kind:'dep'|'missing', inCycle:boolean}>,
 *   cycles: string[][], warnings: object[], malformed: boolean}}
 */
export function buildGraph(view, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const warnings = [];
  const { list, malformed } = packagesOf(view, warnings);
  const pkgs = [];
  const raws = new Map();
  list.forEach((raw, index) => {
    const p = normalizePackage(raw);
    if (!p) return warnings.push({ code: 'badPackage', index });
    if (raws.has(p.id)) return warnings.push({ code: 'duplicateId', id: p.id });
    if (p.rawState !== p.state) warnings.push({ code: 'badState', id: p.id, state: p.rawState });
    raws.set(p.id, raw);
    pkgs.push(p);
    return undefined;
  });
  const byId = new Map(pkgs.map((p) => [p.id, p]));
  const order = pkgs.map((p) => p.id);
  const knownDeps = new Map(pkgs.map((p) => [p.id, p.dependsOn.filter((d) => byId.has(d))]));
  const cycles = findCycles(order, (id) => knownDeps.get(id) || []);
  const cycleIds = new Set(cycles.flat());
  const cycleOf = new Map();
  cycles.forEach((c, i) => c.forEach((id) => cycleOf.set(id, i)));
  for (const c of cycles) warnings.push({ code: 'cycle', ids: [...c] });

  const edges = [];
  const ghosts = [];
  for (const p of pkgs) {
    for (const dep of p.dependsOn) {
      if (byId.has(dep)) {
        const inCycle = cycleOf.has(dep) && cycleOf.get(dep) === cycleOf.get(p.id);
        edges.push({ from: dep, to: p.id, kind: 'dep', inCycle });
        continue;
      }
      warnings.push({ code: 'missingDep', id: p.id, dep });
      if (!ghosts.includes(dep)) ghosts.push(dep);
      edges.push({ from: dep, to: p.id, kind: 'missing', inCycle: false });
    }
  }

  const nodes = pkgs.map((p) => ({
    id: p.id,
    title: p.title,
    state: p.state,
    stateKey: p.stateKey,
    visual: visualOf(p, byId, now),
    elapsedMs: elapsedOf(p, now),
    error: p.error,
    waitingOn: waitingOnOf(p, byId),
    dependsOn: [...p.dependsOn],
    estimateMinutes: p.estimateMinutes,
    ghost: false,
    flags: flagsOf(raws.get(p.id), p, cycleIds),
    pkg: raws.get(p.id),
  }));
  for (const id of ghosts) {
    nodes.push({
      id, title: id, state: 'missing', stateKey: 'missing', visual: 'missing', elapsedMs: null, error: null,
      waitingOn: null, dependsOn: [], estimateMinutes: null, ghost: true, flags: { inCycle: false }, pkg: null,
    });
  }
  return { nodes, edges, cycles, warnings, malformed };
}

/** Walks edges from `id` (cycle-safe); the start itself is not included. */
function walk(graph, id, forward) {
  const next = new Map();
  for (const e of (graph && graph.edges) || []) {
    const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(b);
  }
  const seen = new Set([id]);
  const out = [];
  const queue = [...(next.get(id) || [])];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(next.get(cur) || []));
  }
  return out;
}

/** Every package `id` depends on, directly or not (nearest first). */
export const upstream = (graph, id) => walk(graph, id, false);
/** Every package that depends on `id`, directly or not (nearest first). */
export const downstream = (graph, id) => walk(graph, id, true);

const nodeMap = (graph) => new Map(((graph && graph.nodes) || []).map((n) => [n.id, n]));

/**
 * The chain from a blocked package down to what blocks it: [id, ..., root],
 * where root is failed / stalled / killed / closed / missing (or terminal).
 * [] when the package is not blocked or no such root is found.
 * @param {{nodes:object[]}} graph
 * @param {string} id
 * @returns {string[]}
 */
export function rootBlockers(graph, id) {
  const byId = nodeMap(graph);
  const start = byId.get(id);
  if (!start || start.visual !== 'blocked') return [];
  const isRoot = (n) => n.ghost || ROOT_STATES.has(n.state) || (n.flags.terminal && n.state !== 'pushed');
  const parent = new Map([[id, null]]);
  const queue = [id];
  while (queue.length) {
    const cur = byId.get(queue.shift());
    // The supervisor's own pick (blockedBy / waitingOn) goes first.
    const deps = cur.waitingOn ? [cur.waitingOn, ...cur.dependsOn.filter((d) => d !== cur.waitingOn)] : cur.dependsOn;
    for (const d of deps) {
      if (parent.has(d)) continue;
      parent.set(d, cur.id);
      const dep = byId.get(d) || { id: d, ghost: true, state: 'missing', flags: {} };
      if (isRoot(dep)) {
        const chain = [d];
        for (let p = cur.id; p !== null; p = parent.get(p)) chain.unshift(p);
        return chain;
      }
      if (byId.has(d) && dep.state !== 'pushed') queue.push(d);
    }
  }
  return [];
}

/**
 * The longest chain of unfinished packages (not pushed, not ghosts), weighed
 * by each package's estimateMinutes (DEFAULT_PATH_MINUTES without one).
 * Cycle members are left out, so a cycle never hangs it.
 * @param {{nodes:object[], edges:object[], cycles?:string[][]}} graph
 * @returns {{ids: string[], minutes: number}}
 */
export function criticalPath(graph) {
  const nodes = ((graph && graph.nodes) || []).filter((n) => !n.ghost && n.state !== 'pushed');
  const inCycle = new Set(((graph && graph.cycles) || []).flat());
  const live = nodes.filter((n) => !inCycle.has(n.id));
  const liveIds = new Set(live.map((n) => n.id));
  const pos = new Map(live.map((n, i) => [n.id, i]));
  const weight = (n) => n.estimateMinutes || DEFAULT_PATH_MINUTES;
  const best = new Map();
  const visit = (n) => {
    if (best.has(n.id)) return best.get(n.id);
    best.set(n.id, { minutes: weight(n), prev: null });
    let top = null;
    for (const d of n.dependsOn) {
      if (!liveIds.has(d)) continue;
      const r = visit(live[pos.get(d)]);
      if (!top || r.minutes > top.minutes || (r.minutes === top.minutes && pos.get(d) < pos.get(top.id))) top = { id: d, minutes: r.minutes };
    }
    const res = { minutes: weight(n) + (top ? top.minutes : 0), prev: top ? top.id : null };
    best.set(n.id, res);
    return res;
  };
  let end = null;
  for (const n of live) {
    const r = visit(n);
    if (!end || r.minutes > end.minutes) end = { id: n.id, minutes: r.minutes };
  }
  if (!end) return { ids: [], minutes: 0 };
  const ids = [];
  for (let cur = end.id; cur !== null; cur = best.get(cur).prev) ids.unshift(cur);
  return { ids, minutes: end.minutes };
}

/** Counts per state and per visual (summary view, done banner). */
export function tallyGraph(graph) {
  const byState = {};
  const byVisual = {};
  for (const n of (graph && graph.nodes) || []) {
    if (n.ghost) continue;
    byState[n.stateKey] = (byState[n.stateKey] || 0) + 1;
    byVisual[n.visual] = (byVisual[n.visual] || 0) + 1;
  }
  return { byState, byVisual };
}
