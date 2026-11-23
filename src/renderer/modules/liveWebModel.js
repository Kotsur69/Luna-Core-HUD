// ============================================================================
// LunaCore - God Mode Live Web: the model (pure, no DOM)
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. One God Mode run as a living web, built from three
// read-only feeds the renderer already has:
//
//   the run view       orchestraBoard.viewOf(): packages with their state,
//                      session id, model, verify phase and `touched` (the
//                      repo-relative files git saw them change)
//   the work map       workmapmodel.js tab state per session: context, the
//                      files / subagents / MCP servers its calls touched, its
//                      recent calls, its Luna Core Memory calls
//   the processes      mergeProcs() of each session's process snapshot
//                      (src/sessionProcs.js via workmapSatellites.js)
//
// Layers, from the middle out:
//   Run -> Workers (one per package: model, context %, phase)
//       -> Files      one node per path, shared by every worker that touched
//                     it; `overlap` when 2+ workers CHANGED it and are not
//                     dependency-linked (the board's own rule, src/
//                     orchestraSupervisor.js liveOverlaps)
//       -> Processes / Ports (a port held from 2+ tabs is an overlap too)
//       -> Verify (a package verifying or waiting to) / Subagents / MCP
//          servers (shared by name) / Memory (one Luna Core Memory node)
//
// Workers run in their own worktrees (<parent>/.luna-worktrees/<repo>/<slug>),
// so the same file has a different absolute path per worker; fileKey() maps
// each to its repo-relative path, which is what makes a file shared.
// A package is mapped to its tab through pkg.sessionId; a worker without a
// tab (not launched yet, tab closed) shows without session detail.
// MAX_WEB_NODES caps the web: the least telling nodes go first and every
// layer that lost some gets one "+N" summary node.
//
// Every function returns new objects and never mutates its input. Strings
// that came over IPC are cleaned (cleanText) before they become labels; the
// canvas draws them with fillText, never as HTML.
// ============================================================================

'use strict';

import { pkgStateKey } from './orchestraState.js';
import { cleanText, MAX_DETAIL_CHARS } from './workmapactivity.js';
import { contextFraction } from './workmapmodel.js';

/** Most nodes the web shows; the rest is summarized per layer. */
export const MAX_WEB_NODES = 360;
/** Every layer, middle out ('more' is the per-layer summary node). */
export const LAYERS = Object.freeze(['run', 'worker', 'file', 'process', 'port', 'verify', 'subagent', 'mcp', 'memory', 'more']);
/** Layers a filter toggle can hide; the run and its workers are the web's spine. */
export const FILTER_LAYERS = Object.freeze(['file', 'process', 'port', 'verify', 'subagent', 'mcp', 'memory']);
export const RUN_ID = 'run';
export const MEMORY_ID = 'mem';
/** An exited process or a released port stays (faded) this long after the snapshot that lost it. */
export const GONE_KEEP_MS = 2 * 60 * 1000;
/** Tool events one model change can turn into particle bursts. */
export const MAX_BURST_EVENTS = 24;
/** Longest verify tail kept for the inspector. */
const MAX_TAIL_CHARS = 300;
const MAX_TITLE_CHARS = 120;
const MAX_PATH_CHARS = 1024;
const KNOWN_STATES = new Set(['pending', 'launched', 'finishing', 'pushed', 'failed', 'stalled', 'killed', 'closed']);
const ACTIVE_STATES = new Set(['launched', 'finishing']);
const WORKTREE_MARK = '/.luna-worktrees/';
// Ring radii: workers spread with their number, the outer layers sit past them.
const WORKER_RING_MIN = 170;
const WORKER_RING_PER_NODE = 12;
const OUTER_RING_GAP = 190;
// Rest lengths of the springs.
const RUN_LINK = 190;
const LEAF_LINK = 80;
const PORT_LINK = 50;
const MORE_LINK = 120;
// fileKey()'s memo; cleared whole when full (a run touches far fewer paths).
const FILE_KEY_CACHE_MAX = 4096;
const fileKeyCache = new Map();

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

// ---- keys ----------------------------------------------------------------------

/**
 * The key that makes one file the same node for every worker: the path
 * relative to its worktree (forward slashes) when it lies in a LunaCore
 * worktree, else the path itself with forward slashes. '' for junk.
 * @param {unknown} path
 * @returns {string}
 */
export function fileKey(path) {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS) return '';
  // Every rebuild maps the same paths again: remember them (a pure function, so only a cache).
  const hit = fileKeyCache.get(path);
  if (hit !== undefined) return hit;
  const key = computeFileKey(path);
  if (fileKeyCache.size >= FILE_KEY_CACHE_MAX) fileKeyCache.clear();
  fileKeyCache.set(path, key);
  return key;
}

function computeFileKey(path) {
  const p = path.replace(/\\/g, '/');
  const at = p.toLowerCase().indexOf(WORKTREE_MARK);
  if (at >= 0) {
    // <...>/.luna-worktrees/<repo>/<slug>/<rest>
    const rest = p.slice(at + WORKTREE_MARK.length).split('/').filter(Boolean);
    if (rest.length > 2) return rest.slice(2).join('/');
  }
  return p.replace(/^\.\//, '');
}

/** The last segment of a path ('src/a/b.js' -> 'b.js'). */
export function baseName(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

const edgeId = (from, to) => `${from}>${to}`;
export const workerId = (pkgId) => `w:${pkgId}`;
export const fileId = (key) => `f:${key}`;
const procId = (sid, pid) => `p:${sid}:${pid}`;
const portId = (port) => `port:${port}`;
const agentId = (sid, key) => `a:${sid}:${key}`;
const mcpId = (server) => `m:${server}`;
const verifyId = (pkgId) => `v:${pkgId}`;
const moreId = (layer) => `more:${layer}`;

/** Ring radii for a web with `workers` workers. */
export function ringsFor(workers) {
  const worker = Math.max(WORKER_RING_MIN, count(workers) * WORKER_RING_PER_NODE);
  return { worker, outer: worker + OUTER_RING_GAP };
}

// ---- input --------------------------------------------------------------------------

/** The packages of a view as safe records (no id = skipped, a repeated id = skipped). */
function packagesOf(view) {
  const list = isObj(view) && Array.isArray(view.packages) ? view.packages : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = cleanText(raw.id, MAX_TITLE_CHARS);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = KNOWN_STATES.has(raw.state) ? raw.state : 'pending';
    out.push({
      id,
      title: cleanText(raw.title, MAX_TITLE_CHARS) || id,
      state,
      stateKey: pkgStateKey({ state, verifyPhase: raw.verifyPhase }),
      verifyPhase: raw.verifyPhase === 'queued' || raw.verifyPhase === 'running' ? raw.verifyPhase : null,
      sessionId: str(raw.sessionId),
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d) => typeof d === 'string') : [],
      touched: Array.isArray(raw.touched) ? raw.touched.map(fileKey).filter(Boolean) : [],
      model: cleanText(str(raw.agyModel) || str(raw.model) || '', MAX_TITLE_CHARS),
      branch: cleanText(raw.branch, MAX_TITLE_CHARS),
      verifyRounds: count(raw.verifyRounds),
      verifyTail: cleanText(raw.verifyTail, MAX_TAIL_CHARS),
      error: cleanText(raw.error, MAX_DETAIL_CHARS),
    });
  }
  return out;
}

const tabOf = (tabs, sid) => (sid && tabs instanceof Map && isObj(tabs.get(sid)) ? tabs.get(sid) : null);
const procsOf = (procs, sid) => (sid && procs instanceof Map && procs.get(sid) instanceof Map ? procs.get(sid) : null);
const itemsOf = (tab, station) => (tab && isObj(tab.items) && Array.isArray(tab.items[station]) ? tab.items[station] : []);

/** In-flight, total and failed calls of a tab, over every station. */
function callTotals(tab) {
  const out = { running: 0, calls: 0, failed: 0 };
  if (!tab || !isObj(tab.stations)) return out;
  for (const st of Object.values(tab.stations)) {
    if (!isObj(st)) continue;
    out.running += count(st.inFlight);
    out.calls += count(st.total);
    out.failed += count(st.errors);
  }
  return out;
}

function memoryTotal(tab) {
  const calls = tab && isObj(tab.memoryCalls) ? tab.memoryCalls : null;
  return calls ? Object.values(calls).reduce((s, n) => s + count(n), 0) : 0;
}

// ---- building -----------------------------------------------------------------------

/**
 * A growing web: nodes in order (parents first), edges, and the shared nodes
 * by id so a second worker adds itself to an existing one.
 */
function collector() {
  const nodes = new Map();
  const edges = new Map();
  // Edge id -> the start it falls back to when the cap drops its own (a port's worker).
  const alts = new Map();
  return {
    nodes,
    edges,
    alts,
    node(id, make) {
      if (!nodes.has(id)) nodes.set(id, make());
      return nodes.get(id);
    },
    /** One edge per (from, to); spec: {kind, length, changed?, alt?}. */
    edge(from, to, spec) {
      const id = edgeId(from, to);
      if (edges.has(id)) return edges.get(id);
      const e = { id, from, to, kind: spec.kind, length: spec.length };
      if (spec.changed) e.changed = true;
      edges.set(id, e);
      if (spec.alt) alts.set(id, spec.alt);
      return e;
    },
  };
}

function addWorker(web, p, tab, rings) {
  const id = workerId(p.id);
  const totals = callTotals(tab);
  const fraction = contextFraction(tab);
  const tabModel = tab ? cleanText(str(tab.modelLabel) || str(tab.model) || '', MAX_TITLE_CHARS) : '';
  web.node(id, () => ({
    id, layer: 'worker', label: p.id, title: p.title, parent: RUN_ID, ring: rings.worker,
    pkgId: p.id, sessionId: p.sessionId, hasTab: !!tab, state: p.state, stateKey: p.stateKey,
    phase: p.verifyPhase, active: ACTIVE_STATES.has(p.state), model: tabModel || p.model, branch: p.branch,
    context: fraction, running: totals.running, calls: totals.calls, failed: totals.failed, error: p.error,
  }));
  web.edge(RUN_ID, id, { kind: 'worker', length: RUN_LINK });
  return id;
}

/** Every file a worker touched: git's changed list plus its tab's file items. */
function workerFiles(p, tab) {
  const files = new Map();
  for (const key of p.touched) files.set(key, { key, changed: true, added: 0, removed: 0, calls: 0 });
  for (const it of itemsOf(tab, 'files')) {
    const key = isObj(it) ? fileKey(it.key) : '';
    if (!key) continue;
    const old = files.get(key) || { key, changed: false, added: 0, removed: 0, calls: 0 };
    const added = old.added + count(it.added);
    const removed = old.removed + count(it.removed);
    files.set(key, { key, changed: old.changed || added + removed > 0, added, removed, calls: old.calls + count(it.calls) });
  }
  return [...files.values()];
}

function addFiles(web, p, wid, tab, rings) {
  for (const f of workerFiles(p, tab)) {
    const id = fileId(f.key);
    const node = web.node(id, () => ({ id, layer: 'file', label: baseName(f.key), path: f.key, parent: wid, ring: rings.outer, workers: [] }));
    node.workers.push({ pkgId: p.id, sessionId: p.sessionId, changed: f.changed, added: f.added, removed: f.removed, calls: f.calls });
    web.edge(wid, id, { kind: 'file', length: LEAF_LINK, changed: f.changed });
  }
}

function addProcesses(web, p, wid, procs, rings, now) {
  const seen = procsOf(procs, p.sessionId);
  if (!seen) return;
  const fresh = (it) => it.alive === true || (Number.isFinite(it.lastAt) && now - it.lastAt < GONE_KEEP_MS);
  for (const it of seen.values()) {
    if (!isObj(it) || it.kind !== 'process' || !Number.isSafeInteger(it.pid) || !fresh(it)) continue;
    const id = procId(p.sessionId, it.pid);
    const name = cleanText(it.name, MAX_TITLE_CHARS) || String(it.pid);
    const ports = Array.isArray(it.ports) ? it.ports.filter((n) => Number.isInteger(n) && n > 0 && n <= 65535) : [];
    web.node(id, () => ({
      id, layer: 'process', label: name, parent: wid, ring: rings.outer, pkgId: p.id, sessionId: p.sessionId,
      pid: it.pid, command: cleanText(it.label, MAX_DETAIL_CHARS) || name, ports, alive: it.alive === true,
    }));
    web.edge(wid, id, { kind: 'process', length: LEAF_LINK });
    for (const port of ports) addPort(web, port, { pkgId: p.id, sessionId: p.sessionId, pid: it.pid, name, alive: it.alive === true }, id, wid, rings);
  }
}

function addPort(web, port, holder, from, wid, rings) {
  const id = portId(port);
  const node = web.node(id, () => ({ id, layer: 'port', label: `:${port}`, port, parent: from, ring: rings.outer, holders: [] }));
  if (!node.holders.some((h) => h.sessionId === holder.sessionId && h.pid === holder.pid)) node.holders.push(holder);
  // From its process; from the worker instead when the cap drops the process.
  web.edge(from, id, { kind: 'port', length: PORT_LINK, alt: wid });
}

function addVerify(web, p, wid, rings) {
  const failedVerify = p.state === 'failed' && !!p.verifyTail;
  if (p.state !== 'finishing' && !failedVerify) return;
  const id = verifyId(p.id);
  const phase = failedVerify ? 'failed' : p.verifyPhase || 'running';
  web.node(id, () => ({ id, layer: 'verify', label: p.id, parent: wid, ring: rings.outer, pkgId: p.id, sessionId: p.sessionId, phase, rounds: p.verifyRounds, tail: p.verifyTail }));
  web.edge(wid, id, { kind: 'verify', length: LEAF_LINK });
}

function addAgents(web, p, wid, tab, rings) {
  for (const it of itemsOf(tab, 'agents')) {
    const key = isObj(it) ? cleanText(it.key, MAX_DETAIL_CHARS) : '';
    if (!key) continue;
    const id = agentId(p.sessionId, key);
    web.node(id, () => ({ id, layer: 'subagent', label: key, parent: wid, ring: rings.outer, pkgId: p.id, sessionId: p.sessionId, calls: count(it.calls), failed: count(it.failed), lastAt: Number.isFinite(it.lastAt) ? it.lastAt : null }));
    web.edge(wid, id, { kind: 'subagent', length: LEAF_LINK });
  }
}

function addMcp(web, p, wid, tab, rings) {
  for (const station of ['mcp', 'network']) {
    for (const it of itemsOf(tab, station)) {
      if (!isObj(it) || it.kind !== 'mcp') continue;
      const server = cleanText(it.key, MAX_TITLE_CHARS);
      if (!server) continue;
      const id = mcpId(server);
      const node = web.node(id, () => ({ id, layer: 'mcp', label: server, parent: wid, ring: rings.outer, workers: [] }));
      node.workers.push({ pkgId: p.id, sessionId: p.sessionId, calls: count(it.calls), failed: count(it.failed) });
      web.edge(wid, id, { kind: 'mcp', length: LEAF_LINK });
    }
  }
}

function addMemory(web, p, wid, tab, rings) {
  if (!memoryTotal(tab)) return;
  const node = web.node(MEMORY_ID, () => ({ id: MEMORY_ID, layer: 'memory', label: '', parent: wid, ring: rings.outer, workers: [] }));
  const calls = {};
  for (const [kind, n] of Object.entries(tab.memoryCalls)) calls[kind] = count(n);
  node.workers.push({ pkgId: p.id, sessionId: p.sessionId, calls });
  web.edge(wid, MEMORY_ID, { kind: 'memory', length: LEAF_LINK });
}

/** Two workers that changed one file clash unless one builds on the other. */
function markOverlaps(nodes, byId) {
  const linked = (a, b) => {
    const pa = byId.get(a);
    const pb = byId.get(b);
    return (pa && pa.dependsOn.includes(b)) || (pb && pb.dependsOn.includes(a));
  };
  for (const n of nodes.values()) {
    if (n.layer === 'file') {
      const changers = n.workers.filter((w) => w.changed).map((w) => w.pkgId);
      n.shared = n.workers.length > 1;
      n.changed = changers.length > 0;
      n.overlap = changers.some((a, i) => changers.slice(i + 1).some((b) => a !== b && !linked(a, b)));
    } else if (n.layer === 'port') {
      n.alive = n.holders.some((h) => h.alive);
      n.overlap = new Set(n.holders.filter((h) => h.alive).map((h) => h.sessionId)).size > 1;
    }
  }
}

// ---- the cap ------------------------------------------------------------------------

/** Lower = kept first. */
function rankOf(n) {
  switch (n.layer) {
    case 'run': return 0;
    case 'worker': return n.active ? 1 : 2;
    case 'file': return n.overlap ? 3 : n.changed ? 6 : 11;
    case 'port': return n.overlap ? 3 : 10;
    case 'verify': return 4;
    case 'process': return n.alive ? 5 : 12;
    case 'memory': return 7;
    case 'mcp': return 8;
    case 'subagent': return 9;
    default: return 13;
  }
}

/**
 * Keeps the `cap` most telling nodes (rank, then build order) and summarizes
 * the rest: one 'more' node per layer that lost nodes, hanging off the run.
 * An edge whose start was dropped falls back to its `alt` start (a port to
 * its worker); a leaf left with no edge at all goes too.
 */
function capWeb(nodes, edges, alts, cap, rings) {
  const list = [...nodes.values()];
  if (list.length <= cap) return { nodes: list, edges: [...edges.values()], dropped: {} };
  const order = new Map(list.map((n, i) => [n.id, i]));
  // Room for the summary nodes: at most one per layer.
  const room = Math.max(1, cap - LAYERS.length);
  const kept = new Set([...list].sort((a, b) => rankOf(a) - rankOf(b) || order.get(a.id) - order.get(b.id)).slice(0, room).map((n) => n.id));
  const outEdges = [];
  for (const e of edges.values()) {
    const alt = alts.get(e.id);
    const from = kept.has(e.from) ? e.from : alt && kept.has(alt) ? alt : null;
    if (!from || !kept.has(e.to)) continue;
    outEdges.push(from === e.from ? e : { ...e, id: edgeId(from, e.to), from });
  }
  const linked = new Set(outEdges.flatMap((e) => [e.from, e.to]));
  const spine = (n) => n.layer === 'run' || n.layer === 'worker';
  const keptNodes = list.filter((n) => kept.has(n.id) && (spine(n) || linked.has(n.id)));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const dropped = {};
  for (const n of list) if (!keptIds.has(n.id)) dropped[n.layer] = (dropped[n.layer] || 0) + 1;
  const more = Object.entries(dropped).map(([layer, n]) => ({ id: moreId(layer), layer: 'more', moreOf: layer, count: n, label: `+${n}`, parent: RUN_ID, ring: rings.outer }));
  const moreEdges = more.map((m) => ({ id: edgeId(RUN_ID, m.id), from: RUN_ID, to: m.id, kind: 'more', length: MORE_LINK }));
  return { nodes: [...keptNodes, ...more], edges: [...outEdges.filter((e) => keptIds.has(e.from)), ...moreEdges], dropped };
}

/**
 * @typedef {object} Web
 * @property {object[]} nodes parents before children; every node has id, layer, label, parent, ring
 * @property {Array<{id:string, from:string, to:string, kind:string, length:number}>} edges
 * @property {Record<string, number>} dropped nodes per layer the cap left out
 * @property {{workers:number, files:number, overlaps:number, processes:number, ports:number}} counts
 * @property {Map<string, string>} bySession session id -> worker node id
 */

/**
 * The Live Web of one run.
 * @param {{view:object|null, tabs?:Map<string, object>|null, procs?:Map<string, Map<string, object>>|null,
 *   runLabel?:string, now?:number, cap?:number}} input
 * @returns {Web}
 */
export function buildWeb(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const cap = Number.isSafeInteger(input.cap) && input.cap > LAYERS.length ? input.cap : MAX_WEB_NODES;
  const packages = packagesOf(input.view);
  const rings = ringsFor(packages.length);
  const web = collector();
  const killed = isObj(input.view) && input.view.killed === true;
  web.node(RUN_ID, () => ({
    id: RUN_ID, layer: 'run', label: cleanText(input.runLabel, MAX_TITLE_CHARS), parent: null, ring: null, fixed: { x: 0, y: 0 },
    total: packages.length, active: packages.filter((p) => ACTIVE_STATES.has(p.state)).length,
    pushed: packages.filter((p) => p.state === 'pushed').length, failed: packages.filter((p) => p.state === 'failed').length, killed,
  }));
  const bySession = new Map();
  // Workers first, so every leaf finds its parent already placed.
  const workers = packages.map((p) => {
    const tab = tabOf(input.tabs, p.sessionId);
    const wid = addWorker(web, p, tab, rings);
    if (p.sessionId) bySession.set(p.sessionId, wid);
    return { p, wid, tab };
  });
  for (const { p, wid, tab } of workers) {
    addVerify(web, p, wid, rings);
    addFiles(web, p, wid, tab, rings);
    addProcesses(web, p, wid, input.procs, rings, now);
    addAgents(web, p, wid, tab, rings);
    addMcp(web, p, wid, tab, rings);
    addMemory(web, p, wid, tab, rings);
  }
  markOverlaps(web.nodes, new Map(packages.map((p) => [p.id, p])));
  const capped = capWeb(web.nodes, web.edges, web.alts, cap, rings);
  const shown = (layer) => capped.nodes.filter((n) => n.layer === layer);
  const keptIds = new Set(capped.nodes.map((n) => n.id));
  for (const [sid, wid] of [...bySession]) if (!keptIds.has(wid)) bySession.delete(sid);
  return {
    ...capped,
    counts: {
      workers: packages.length,
      files: [...web.nodes.values()].filter((n) => n.layer === 'file').length,
      overlaps: shown('file').filter((n) => n.overlap).length + shown('port').filter((n) => n.overlap).length,
      processes: shown('process').filter((n) => n.alive).length,
      ports: shown('port').length,
    },
    bySession,
  };
}

/**
 * The web without the layers a filter hides (and their summary nodes); the
 * run and the workers always stay.
 * @param {Web} web
 * @param {Iterable<string>} hidden layer names from FILTER_LAYERS
 * @returns {Web}
 */
export function filterWeb(web, hidden) {
  const off = new Set([...(hidden || [])].filter((l) => FILTER_LAYERS.includes(l)));
  if (!off.size) return web;
  const keep = (n) => !off.has(n.layer) && !(n.layer === 'more' && off.has(n.moreOf));
  const nodes = web.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  return { ...web, nodes, edges: web.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/**
 * The hidden layers as remembered ('file,port'): known filter layers only.
 * Anything else stored there (junk, an old layer name) is ignored.
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function parseHiddenLayers(text) {
  if (typeof text !== 'string' || !text) return new Set();
  return new Set(text.split(',').map((s) => s.trim()).filter((l) => FILTER_LAYERS.includes(l)));
}

/** The hidden layers as stored, in FILTER_LAYERS order. */
export const hiddenLayersText = (hidden) => FILTER_LAYERS.filter((l) => hidden instanceof Set && hidden.has(l)).join(',');

// ---- tool events -> particle bursts ------------------------------------------------

/**
 * What a worker's tab did between two model states, from its `recent` calls:
 * a call new since `prev` starts (and also ends when it already settled), a
 * running one that settled ends. Capped at MAX_BURST_EVENTS, newest kept.
 * @param {{recent?:object[]}|null} prev
 * @param {{recent?:object[]}|null} next
 * @returns {Array<{callId:string, station:string, file:string, detail:string, phase:'start'|'end', failed:boolean}>}
 */
export function toolEvents(prev, next) {
  const after = next && Array.isArray(next.recent) ? next.recent : [];
  const before = new Map((prev && Array.isArray(prev.recent) ? prev.recent : []).filter(isObj).map((r) => [r.callId, r.status]));
  if (!prev) return [];
  const out = [];
  for (const r of after) {
    if (!isObj(r) || typeof r.callId !== 'string') continue;
    const base = { callId: r.callId, station: str(r.station) || 'other', file: str(r.file) || '', detail: str(r.detail) || '' };
    const was = before.get(r.callId);
    if (was === undefined) out.push({ ...base, phase: 'start', failed: false });
    if (r.status !== 'running' && (was === undefined || was === 'running')) out.push({ ...base, phase: 'end', failed: r.status === 'failed' });
  }
  return out.length > MAX_BURST_EVENTS ? out.slice(out.length - MAX_BURST_EVENTS) : out;
}

/**
 * The edge a tool event travels along: from the worker to what the call
 * touched (its file, subagent, MCP server, Memory, or a live process for a
 * shell call), else from the run to the worker. Null when the worker is not
 * in the web.
 * @param {Web} web
 * @param {string} sessionId
 * @param {{station:string, file:string, detail:string, phase:string}} ev
 * @returns {{edge:string, reverse:boolean}|null}
 */
export function burstEdge(web, sessionId, ev) {
  const wid = web && web.bySession instanceof Map ? web.bySession.get(sessionId) : null;
  if (!wid || !isObj(ev)) return null;
  const has = new Set(web.edges.map((e) => e.id));
  let target = null;
  if (ev.station === 'files' && ev.file) target = fileId(fileKey(ev.file));
  else if (ev.station === 'agents' && ev.detail) target = agentId(sessionId, ev.detail);
  else if ((ev.station === 'mcp' || ev.station === 'network') && ev.detail) target = mcpId(ev.detail);
  else if (ev.station === 'memory') target = MEMORY_ID;
  else if (ev.station === 'shell') {
    const proc = web.nodes.find((n) => n.layer === 'process' && n.sessionId === sessionId && n.alive);
    target = proc ? proc.id : null;
  }
  const reverse = ev.phase === 'end';
  if (target && has.has(edgeId(wid, target))) return { edge: edgeId(wid, target), reverse };
  const spine = edgeId(RUN_ID, wid);
  return has.has(spine) ? { edge: spine, reverse } : null;
}
