// ============================================================================
// LunaCore - God Mode Live Web: force-directed layout (pure, deterministic)
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. Places the Live Web's nodes (liveWebModel.js) with a
// small spring-electrical simulation:
//
//   repulsion  every pair pushes apart (1/d, cut off at MAX_REPULSE_DIST)
//   springs    every edge pulls its ends toward the edge's rest length
//   rings      a node with a `ring` is pulled toward that distance from the
//              origin, so the layers read as rings (run, workers, the rest)
//   centering  a weak pull toward the origin keeps the web from drifting
//   damping    velocity decays every step; `alpha` cools from 1 toward 0 and
//              scales every force, so the layout always comes to rest
//
// Deterministic: start positions are seeded from each node's id (FNV-1a +
// mulberry32), never Math.random, and every step is a fixed time step - the
// same graph and the same number of steps give the same positions. The view
// runs whole steps from an accumulator, never a step scaled by frame time.
// Never NaN: inputs are validated, coincident nodes get a seeded nudge, speed
// is capped, and a node that still went non-finite is put back on its seed.
//
// The simulation object is mutated in place by step() (it is a simulation;
// copying 400 nodes per frame would only make garbage). Nothing here touches
// the DOM or a timer: node --test imports it directly.
// ============================================================================

'use strict';

/** Velocity kept per step (1 - this is the decay). */
export const VELOCITY_KEEP = 0.6;
/** Repulsion strength between any two nodes. */
export const CHARGE = 260;
/** Pairs further apart than this do not repel (keeps far layers independent). */
export const MAX_REPULSE_DIST = 700;
/** Distances below this count as this, so a near-coincident pair cannot explode. */
export const MIN_DIST = 1;
/** Spring stiffness of an edge (scaled per edge by `strength`). */
export const SPRING_K = 0.08;
/** Rest length of an edge that names none. */
export const DEFAULT_LINK_LENGTH = 70;
/** Pull toward a node's ring radius. */
export const RING_K = 0.06;
/** Pull toward the origin. */
export const CENTER_K = 0.004;
/** Fastest a node may move in one step, in layout units. */
export const MAX_SPEED = 40;
/** Below this alpha the layout is at rest. */
export const ALPHA_MIN = 0.002;
/** Alpha lost per step (about 300 steps from 1 to ALPHA_MIN). */
export const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);
/** Alpha a changed graph restarts from (it was already near its shape). */
export const REHEAT_ALPHA = 0.5;
/** The most steps settle() runs. */
export const MAX_SETTLE_STEPS = 800;
/** How far from its parent a new node is seeded. */
const SEED_SPREAD = 40;
/** Seeded nodes without a parent or ring start inside this radius. */
const SEED_RADIUS = 120;

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** FNV-1a 32-bit hash of a string. */
export function hashString(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded generator of floats in [0, 1) (mulberry32). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} SimNode
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number|null} ring target distance from the origin, null for none
 * @property {{x:number, y:number}|null} fixed where the model nails it (the run), null otherwise
 * @property {{x:number, y:number}|null} pinned where a drag holds it, null otherwise
 * @property {number} sx seed x (the reset point for a non-finite node)
 * @property {number} sy seed y
 */

/**
 * @typedef {object} Sim
 * @property {SimNode[]} nodes
 * @property {Map<string, number>} index id -> position in `nodes`
 * @property {Array<{a:number, b:number, length:number, strength:number}>} links
 * @property {number} alpha
 * @property {number} steps steps taken since creation
 */

/** @returns {Sim} an empty simulation */
export function createSim() {
  return { nodes: [], index: new Map(), links: [], alpha: 1, steps: 0 };
}

/** Where a new node starts: near its parent when the parent is placed, else on its ring. */
function seedOf(spec, placed) {
  const rnd = seededRandom(hashString(spec.id));
  const angle = rnd() * Math.PI * 2;
  const parent = typeof spec.parent === 'string' ? placed.get(spec.parent) : null;
  if (parent) {
    const r = SEED_SPREAD * (0.5 + rnd());
    return { x: parent.x + Math.cos(angle) * r, y: parent.y + Math.sin(angle) * r };
  }
  const ring = finite(spec.ring, null);
  const r = ring !== null && ring > 0 ? ring : SEED_RADIUS * rnd();
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

const pointOf = (v) => (v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null);

/**
 * Gives the simulation a new graph. A node already in it keeps its place and
 * speed; a new one is seeded (deterministically) next to its parent. Nodes
 * whose ids repeat, or that are not objects with an id, are skipped; edges to
 * unknown ids are dropped. A graph that changed reheats the layout.
 * Parents must come before their children for a child to start beside its
 * parent (liveWebModel.js orders them so); otherwise it starts on its ring.
 * @param {Sim} sim
 * @param {Array<{id:string, ring?:number|null, parent?:string|null, fixed?:{x:number,y:number}|null}>} nodes
 * @param {Array<{from:string, to:string, length?:number, strength?:number}>} edges
 * @returns {boolean} whether the node or edge set changed
 */
export function setGraph(sim, nodes, edges) {
  const old = new Map(sim.nodes.map((n) => [n.id, n]));
  const next = [];
  const index = new Map();
  const placed = new Map();
  let changed = false;
  for (const spec of Array.isArray(nodes) ? nodes : []) {
    if (!spec || typeof spec.id !== 'string' || !spec.id || index.has(spec.id)) continue;
    const prev = old.get(spec.id);
    const fixed = pointOf(spec.fixed);
    const ring = finite(spec.ring, null);
    let node;
    if (prev) {
      node = { ...prev, ring, fixed };
    } else {
      changed = true;
      const seed = fixed || seedOf(spec, placed);
      node = { id: spec.id, x: seed.x, y: seed.y, vx: 0, vy: 0, ring, fixed, pinned: null, sx: seed.x, sy: seed.y };
    }
    index.set(node.id, next.length);
    next.push(node);
    placed.set(node.id, node);
  }
  if (next.length !== sim.nodes.length) changed = true;
  const links = [];
  const seen = new Set();
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || !index.has(e.from) || !index.has(e.to) || e.from === e.to) continue;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const length = finite(e.length, DEFAULT_LINK_LENGTH);
    const strength = finite(e.strength, 1);
    links.push({ a: index.get(e.from), b: index.get(e.to), length: length > 0 ? length : DEFAULT_LINK_LENGTH, strength: Math.max(0, strength) });
  }
  const linkSig = (list, ids) => list.map((l) => `${ids[l.a]}>${ids[l.b]}`).join('|');
  if (!changed && linkSig(links, next.map((n) => n.id)) !== linkSig(sim.links, sim.nodes.map((n) => n.id))) changed = true;
  sim.nodes = next;
  sim.index = index;
  sim.links = links;
  if (changed) sim.alpha = Math.max(sim.alpha, REHEAT_ALPHA);
  return changed;
}

/** A small seeded push for a pair sitting on the same point. */
function nudge(i, j) {
  const rnd = seededRandom((i * 73856093) ^ (j * 19349663));
  const angle = rnd() * Math.PI * 2;
  return { dx: Math.cos(angle) * MIN_DIST, dy: Math.sin(angle) * MIN_DIST };
}

function applyRepulsion(nodes, alpha) {
  const maxD2 = MAX_REPULSE_DIST * MAX_REPULSE_DIST;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > maxD2) continue;
      if (d2 === 0) {
        ({ dx, dy } = nudge(i, j));
        d2 = dx * dx + dy * dy;
      }
      const d2c = Math.max(d2, MIN_DIST * MIN_DIST);
      // Magnitude CHARGE / d along the unit vector: CHARGE * (dx / d) / d.
      const f = (CHARGE * alpha) / d2c;
      a.vx -= dx * f;
      a.vy -= dy * f;
      b.vx += dx * f;
      b.vy += dy * f;
    }
  }
}

function applySprings(nodes, links, alpha) {
  for (const l of links) {
    const a = nodes[l.a];
    const b = nodes[l.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.hypot(dx, dy), MIN_DIST);
    const f = ((d - l.length) / d) * SPRING_K * l.strength * alpha * 0.5;
    a.vx += dx * f;
    a.vy += dy * f;
    b.vx -= dx * f;
    b.vy -= dy * f;
  }
}

function applyRingsAndCenter(nodes, alpha) {
  for (const n of nodes) {
    n.vx -= n.x * CENTER_K * alpha;
    n.vy -= n.y * CENTER_K * alpha;
    if (n.ring === null || n.ring <= 0) continue;
    const r = Math.hypot(n.x, n.y);
    if (r < MIN_DIST) continue;
    const k = ((n.ring - r) / r) * RING_K * alpha;
    n.vx += n.x * k;
    n.vy += n.y * k;
  }
}

function integrate(nodes) {
  for (const n of nodes) {
    const hold = n.pinned || n.fixed;
    if (hold) {
      n.x = hold.x;
      n.y = hold.y;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= VELOCITY_KEEP;
    n.vy *= VELOCITY_KEEP;
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > MAX_SPEED) {
      n.vx = (n.vx / speed) * MAX_SPEED;
      n.vy = (n.vy / speed) * MAX_SPEED;
    }
    n.x += n.vx;
    n.y += n.vy;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.vx) || !Number.isFinite(n.vy)) {
      n.x = n.sx;
      n.y = n.sy;
      n.vx = 0;
      n.vy = 0;
    }
  }
}

/**
 * Runs `count` fixed steps (none once at rest, unless a drag holds a node).
 * @param {Sim} sim
 * @param {number} [count=1]
 * @returns {number} alpha after the steps
 */
export function step(sim, count = 1) {
  const n = Math.max(0, Math.floor(finite(count, 1)));
  for (let s = 0; s < n; s += 1) {
    if (isSettled(sim)) break;
    // A held node keeps the rest of the web gently awake around it.
    const alpha = Math.max(sim.alpha, sim.nodes.some((node) => node.pinned) ? ALPHA_MIN * 10 : 0);
    applyRepulsion(sim.nodes, alpha);
    applySprings(sim.nodes, sim.links, alpha);
    applyRingsAndCenter(sim.nodes, alpha);
    integrate(sim.nodes);
    sim.alpha = Math.max(0, sim.alpha - sim.alpha * ALPHA_DECAY);
    sim.steps += 1;
  }
  return sim.alpha;
}

/** Whether the layout is at rest (a node held by a drag keeps it awake). */
export function isSettled(sim) {
  return sim.alpha < ALPHA_MIN && !sim.nodes.some((n) => n.pinned);
}

/**
 * Steps until the layout is at rest, at most `maxSteps`.
 * @param {Sim} sim
 * @param {number} [maxSteps=MAX_SETTLE_STEPS]
 * @returns {number} steps taken
 */
export function settle(sim, maxSteps = MAX_SETTLE_STEPS) {
  const before = sim.steps;
  const limit = Math.max(0, Math.floor(finite(maxSteps, MAX_SETTLE_STEPS)));
  while (sim.steps - before < limit && !isSettled(sim)) step(sim, 1);
  return sim.steps - before;
}

/** Restarts the cooling from at least `alpha` (a drag, a filter change). */
export function reheat(sim, alpha = REHEAT_ALPHA) {
  sim.alpha = Math.min(1, Math.max(sim.alpha, finite(alpha, REHEAT_ALPHA)));
}

/** Holds a node where a drag put it; false for an unknown id or a bad point. */
export function pin(sim, id, x, y) {
  const i = sim.index.get(id);
  if (i === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const n = sim.nodes[i];
  n.pinned = { x, y };
  n.x = x;
  n.y = y;
  n.vx = 0;
  n.vy = 0;
  return true;
}

/** Lets a dragged node go; the web around it settles again from a warm start. */
export function unpin(sim, id) {
  const i = sim.index.get(id);
  if (i === undefined) return false;
  sim.nodes[i].pinned = null;
  reheat(sim, 0.1);
  return true;
}

/** A node's position, or null. */
export function positionOf(sim, id) {
  const i = sim.index.get(id);
  return i === undefined ? null : { x: sim.nodes[i].x, y: sim.nodes[i].y };
}

/** The box around every node, or null for an empty simulation. */
export function bounds(sim) {
  if (!sim.nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of sim.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Mean squared speed per node (0 for an empty simulation). */
export function kineticEnergy(sim) {
  if (!sim.nodes.length) return 0;
  let sum = 0;
  for (const n of sim.nodes) sum += n.vx * n.vx + n.vy * n.vy;
  return sum / sim.nodes.length;
}
