// ============================================================================
// LunaCore - Live map (Ctrl+Shift+G): pure helpers
// ----------------------------------------------------------------------------
// Everything in the live map that can be decided without a document: which
// tab / direction is remembered, what the God Mode tab shows for a run (a
// message, the graph, or the big-run summary), the search filter, zoom
// limits and the elapsed-time label. No DOM, no window, no i18n lookups:
// node --test imports it directly (test/liveMap.test.js).
// ============================================================================

'use strict';

/** Tabs of the overlay, in visual order. */
export const TAB_KEYS = ['sessions', 'godmode', 'lunaswork'];
export const DEFAULT_TAB = 'godmode';
export const DIRECTIONS = ['LR', 'TB'];
/** Above this many packages the God Mode tab shows a summary instead of the graph. */
export const GRAPH_SUMMARY_LIMIT = 150;
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 3;
/** One +/- key press or toolbar click. */
export const ZOOM_STEP = 1.2;
export const STORAGE_TAB = 'lunacore.liveMap.tab';
export const STORAGE_DIR = 'lunacore.liveMap.direction';
// Summary lists are clickable; past this they say "+N more".
const SUMMARY_LIST_MAX = 30;
// Order the summary counts read in (the board's own state order).
const STATE_ORDER = ['launched', 'finishing', 'waitingVerify', 'stalled', 'failed', 'pending', 'pushed', 'killed', 'closed'];

/**
 * A remembered value, or the fallback when storage is missing, throws or holds junk.
 * @param {{getItem:(k:string) => string|null}|null|undefined} storage
 * @param {string} key
 * @param {string[]} allowed
 * @param {string} fallback
 */
export function readPref(storage, key, allowed, fallback) {
  try {
    const v = storage ? storage.getItem(key) : null;
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Stores a value; false when storage is missing or refuses it (private mode, quota). */
export function writePref(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const clampZoom = (k) => (Number.isFinite(k) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k)) : 1);

/**
 * The i18n key + params of an elapsed time ("45 s", "12 min", "1 h 05 min"), or null.
 * @param {number|null} ms
 * @returns {{key:string, params:object}|null}
 */
export function elapsedLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return { key: 'lm.elapsed.s', params: { s } };
  const m = Math.floor(s / 60);
  if (m < 60) return { key: 'lm.elapsed.m', params: { m } };
  return { key: 'lm.elapsed.h', params: { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') } };
}

/** A title cut to `max` characters with an ellipsis. */
export function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/**
 * Whether a node matches the search box: every word must appear in its
 * title, id, state, visual or the localized state label.
 * @param {{id:string, title:string, state:string, stateKey?:string, visual?:string}} node
 * @param {string} query
 * @param {string} [stateLabel]
 */
export function matchesFilter(node, query, stateLabel = '') {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [node.id, node.title, node.state, node.stateKey, node.visual, stateLabel].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const realNodes = (graph) => ((graph && graph.nodes) || []).filter((n) => !n.ghost);

/**
 * What the God Mode tab shows.
 * @param {object|null} view the run view
 * @param {{nodes:object[], malformed:boolean}} graph
 * @param {{loading?: boolean}} [opts]
 * @returns {{kind:'loading'|'noRun'|'malformed'|'noPackages'|'summary'|'graph', banner:null|'done'|'failed'|'killed', single:boolean}}
 */
export function graphStatus(view, graph, opts = {}) {
  const none = (kind) => ({ kind, banner: null, single: false });
  if (!view) return none(opts.loading ? 'loading' : 'noRun');
  if (graph.malformed) return none('malformed');
  const nodes = realNodes(graph);
  if (!nodes.length) return none('noPackages');
  const kind = nodes.length > GRAPH_SUMMARY_LIMIT ? 'summary' : 'graph';
  const active = nodes.some((n) => n.state === 'launched' || n.state === 'finishing');
  let banner = null;
  if (view.killed === true) banner = 'killed';
  else if (nodes.every((n) => n.state === 'pushed')) banner = 'done';
  else if (!active && nodes.some((n) => n.state === 'failed' || n.visual === 'longStalled')) banner = 'failed';
  return { kind, banner, single: nodes.length === 1 };
}

/**
 * The "done" summary: pushed / merged counts and the run's wall time.
 * @param {object} view
 * @param {{nodes:object[]}} graph
 */
export function doneSummary(view, graph) {
  const nodes = realNodes(graph);
  const ends = nodes.map((n) => n.pkg && n.pkg.finishedAt).filter(Number.isFinite);
  const start = view && Number.isFinite(view.runStartedAt) ? view.runStartedAt : null;
  const wallMs = start !== null && ends.length ? Math.max(0, Math.max(...ends) - start) : null;
  return {
    total: nodes.length,
    pushed: nodes.filter((n) => n.state === 'pushed').length,
    merged: nodes.filter((n) => n.visual === 'merged').length,
    wallMs,
  };
}

/**
 * The big-run summary: counts per state and the clickable failed / blocked / active lists.
 * @param {{nodes:object[]}} graph
 */
export function summaryLists(graph) {
  const nodes = realNodes(graph);
  const counts = {};
  for (const n of nodes) counts[n.stateKey] = (counts[n.stateKey] || 0) + 1;
  const ordered = Object.keys(counts).sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a);
    const ib = STATE_ORDER.indexOf(b);
    return (ia < 0 ? STATE_ORDER.length : ia) - (ib < 0 ? STATE_ORDER.length : ib) || a.localeCompare(b);
  });
  const list = (pred) => {
    const all = nodes.filter(pred);
    return { items: all.slice(0, SUMMARY_LIST_MAX).map((n) => ({ id: n.id, title: n.title, stateKey: n.stateKey })), more: Math.max(0, all.length - SUMMARY_LIST_MAX) };
  };
  return {
    counts: ordered.map((key) => ({ key, n: counts[key] })),
    failed: list((n) => n.visual === 'failed' || n.visual === 'longStalled' || n.visual === 'killed'),
    blocked: list((n) => n.visual === 'blocked'),
    active: list((n) => n.visual === 'active'),
  };
}

/**
 * The next tab for ArrowLeft / ArrowRight / Home / End on the tab strip, or null.
 * @param {string} key
 * @param {string} current
 */
export function nextTab(key, current) {
  const i = Math.max(0, TAB_KEYS.indexOf(current));
  if (key === 'Home') return TAB_KEYS[0];
  if (key === 'End') return TAB_KEYS[TAB_KEYS.length - 1];
  if (key === 'ArrowRight') return TAB_KEYS[(i + 1) % TAB_KEYS.length];
  if (key === 'ArrowLeft') return TAB_KEYS[(i - 1 + TAB_KEYS.length) % TAB_KEYS.length];
  return null;
}

/** Run chips the live map offers: only projects that have a run. */
export const runChips = (chips) => (Array.isArray(chips) ? chips.filter((c) => c && c.state !== 'none') : []);
