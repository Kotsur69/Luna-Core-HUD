// ============================================================================
// LunaCore - God Mode package graph: the SVG view
// ----------------------------------------------------------------------------
// Draws a graph (orchestraGraphModel.js) at the positions of its layout
// (orchestraGraphLayout.js) into a host element. Reusable: the live map's
// God Mode tab mounts one, and the Luna's Work tab can mount another.
//
//  - Elements are keyed by node id / edge key and reused across updates;
//    every update() lands in the next animation frame, batched.
//  - Node DOM order is the layout order, so Tab walks the graph layer by
//    layer; Enter / Space selects, double-click opens.
//  - Pan by dragging the background, zoom with the wheel (at the cursor) or
//    zoomBy() (+/- keys and the toolbar). Zoom and pan never animate: they
//    follow the hand or the keyboard.
//  - Colours come from the theme's CSS tokens (styles.css .lm-*), so every
//    theme works; the active pulse is CSS and stops under reduced motion.
//  - Data goes in through textContent / setAttribute only, never innerHTML.
// ============================================================================

'use strict';

import { t } from './util.js';
import { clampZoom, elapsedLabel, truncate, ZOOM_STEP } from './liveMapHelpers.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FIT_PAD = 40;
const FIT_MAX_ZOOM = 1.25;
const WHEEL_ZOOM_RATE = 0.0015;
// A pointer that moved less than this between down and up was a click.
const DRAG_SLOP_PX = 4;
// Rough glyph widths (no text measuring: it would force a layout per node).
const TITLE_CHAR_PX = 7.2;
const BADGE_CHAR_PX = 6.2;
const BADGE_PAD = 8;
const RING_GAP = 4;
const BACK_EDGE_BULGE = 90;
let viewSeq = 0;

function svg(tag, cls) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  return node;
}

const setAttrs = (el, attrs) => {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
};

// JSON, not "a->b": package ids are not validated, and "a->b"+"c" would collide with "a"+"b->c".
const pairKey = (from, to) => JSON.stringify([from, to]);
const edgeKey = (e) => pairKey(e.from, e.to);

/** The cubic path of an edge; back edges arc around instead of crossing the nodes. */
function edgePath(e, dir) {
  const [[x1, y1], [x2, y2]] = e.points;
  const b = BACK_EDGE_BULGE;
  if (e.back) {
    return dir === 'LR'
      ? `M${x1},${y1} C${x1 + b},${y1 + b} ${x2 - b},${y2 + b} ${x2},${y2}`
      : `M${x1},${y1} C${x1 + b},${y1 + b} ${x2 + b},${y2 - b} ${x2},${y2}`;
  }
  if (dir === 'LR') {
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  const dy = Math.max(30, (y2 - y1) / 2);
  return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
}

/** The localized state of a node (the board's own labels). */
export function nodeStateText(node) {
  return node.ghost ? t('lm.node.missing') : t(`orch.state.${node.stateKey}`);
}

/** The time / waiting hint under a node's title. */
export function nodeHintText(node) {
  if (node.visual === 'blocked' && node.waitingOn) return t('lm.node.waitingOn', { id: node.waitingOn });
  if (node.flags && node.flags.recoverAsk) return t('lm.node.ask');
  const label = elapsedLabel(node.elapsedMs);
  return label ? t(label.key, label.params) : '';
}

function buildNode(id) {
  const g = svg('g', 'lm-node');
  g.dataset.id = id;
  g.setAttribute('tabindex', '0');
  g.setAttribute('role', 'button');
  const parts = {
    ring: svg('rect', 'lm-node__ring'),
    box: svg('rect', 'lm-node__box'),
    stripe: svg('rect', 'lm-node__stripe'),
    title: svg('text', 'lm-node__title'),
    badge: svg('rect', 'lm-node__badge'),
    badgeText: svg('text', 'lm-node__badgetext'),
    hint: svg('text', 'lm-node__hint'),
  };
  g.append(...Object.values(parts));
  return { g, ...parts, sig: '' };
}

/** Writes one node's geometry and text; skipped when nothing it shows changed. */
function paintNode(item, node, pos, cls) {
  const state = nodeStateText(node);
  const hint = nodeHintText(node);
  const sig = [pos.x, pos.y, pos.w, pos.h, node.title, node.id, state, hint, cls].join('|');
  if (sig === item.sig) return;
  item.sig = sig;
  const { g, ring, box, stripe, title, badge, badgeText } = item;
  g.setAttribute('class', cls);
  g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
  g.setAttribute('aria-label', `${node.title} (${node.id}), ${state}${hint ? `, ${hint}` : ''}`);
  setAttrs(ring, { x: -RING_GAP, y: -RING_GAP, width: pos.w + RING_GAP * 2, height: pos.h + RING_GAP * 2, rx: 11 });
  setAttrs(box, { x: 0, y: 0, width: pos.w, height: pos.h, rx: 8 });
  setAttrs(stripe, { x: 0, y: 0, width: 4, height: pos.h, rx: 2 });
  setAttrs(title, { x: 14, y: 24 });
  title.textContent = truncate(node.title, Math.floor((pos.w - 24) / TITLE_CHAR_PX));
  const badgeW = Math.round(state.length * BADGE_CHAR_PX + BADGE_PAD * 2);
  setAttrs(badge, { x: 12, y: pos.h - 26, width: badgeW, height: 18, rx: 9 });
  setAttrs(badgeText, { x: 12 + BADGE_PAD, y: pos.h - 13 });
  badgeText.textContent = state;
  setAttrs(item.hint, { x: pos.w - 12, y: pos.h - 13 });
  item.hint.textContent = truncate(hint, Math.max(4, Math.floor((pos.w - badgeW - 36) / BADGE_CHAR_PX)));
}

function buildSvg(arrowId) {
  const root = svg('svg', 'lm-graph');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('lm.graph.label'));
  const defs = svg('defs');
  const marker = svg('marker');
  // userSpaceOnUse: the arrow keeps its size on the thicker critical-path edges.
  setAttrs(marker, {
    id: arrowId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
  });
  const tip = svg('path', 'lm-arrow');
  tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
  marker.append(tip);
  defs.append(marker);
  const viewport = svg('g', 'lm-viewport');
  const edgeLayer = svg('g', 'lm-edges');
  const nodeLayer = svg('g', 'lm-nodes');
  viewport.append(edgeLayer, nodeLayer);
  root.append(defs, viewport);
  return { root, viewport, edgeLayer, nodeLayer };
}

/** The class list of a node for this frame's selection / emphasis / path. */
function nodeClass(node, state, emphasis, pathSet) {
  const cls = ['lm-node', `is-${node.visual}`];
  if (node.id === state.selectedId) cls.push('is-selected');
  if (emphasis && !emphasis.has(node.id)) cls.push('is-dim');
  if (pathSet.has(node.id)) cls.push('is-path');
  if (node.flags && node.flags.inCycle) cls.push('is-cycle');
  return cls.join(' ');
}

function edgeClass(e, key, emphasis, pathPairs) {
  const cls = ['lm-edge', `is-${e.kind}`];
  if (e.back) cls.push('is-back');
  if (pathPairs.has(key)) cls.push('is-path');
  if (emphasis && !(emphasis.has(e.from) && emphasis.has(e.to))) cls.push('is-dim');
  return cls.join(' ');
}

/**
 * Mounts a graph view into `host`.
 * @param {HTMLElement} host
 * @param {{onSelect?:(id:string|null) => void, onOpen?:(id:string) => void,
 *   onHover?:(id:string|null, rect:DOMRect|null) => void}} [handlers]
 */
export function createGraphView(host, handlers = {}) {
  viewSeq += 1;
  const arrowId = `lm-arrow-${viewSeq}`;
  const { root, viewport, edgeLayer, nodeLayer } = buildSvg(arrowId);
  const banner = document.createElement('div');
  banner.className = 'lm-graph__banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  host.append(banner, root);

  const nodeEls = new Map();
  const edgeEls = new Map();
  let pending = null;
  let frame = 0;
  let layout = null;
  const tf = { x: 0, y: 0, k: 1 };

  function drawNodes(graph, lay, state, emphasis, pathSet) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const live = new Set();
    const wanted = [];
    for (const pos of lay.nodes) {
      const node = byId.get(pos.id);
      if (!node) continue;
      live.add(pos.id);
      let item = nodeEls.get(pos.id);
      if (!item) {
        item = buildNode(pos.id);
        nodeEls.set(pos.id, item);
      }
      paintNode(item, node, pos, nodeClass(node, state, emphasis, pathSet));
      wanted.push(item.g);
    }
    for (const [id, item] of nodeEls) {
      if (live.has(id)) continue;
      item.g.remove();
      nodeEls.delete(id);
    }
    // DOM order = layout order, so Tab walks the graph as it is drawn. Moving
    // a focused element blurs it, so reorder only on a real change, then refocus.
    const current = nodeLayer.children;
    const same = current.length === wanted.length && wanted.every((g, i) => current[i] === g);
    if (same) return;
    const focused = document.activeElement;
    nodeLayer.append(...wanted);
    if (focused && focused.isConnected && nodeLayer.contains(focused) && document.activeElement !== focused) focused.focus();
  }

  function drawEdges(lay, emphasis, pathPairs) {
    const live = new Set();
    for (const e of lay.edges) {
      const key = edgeKey(e);
      live.add(key);
      let p = edgeEls.get(key);
      if (!p) {
        p = svg('path');
        p.setAttribute('marker-end', `url(#${arrowId})`);
        edgeLayer.append(p);
        edgeEls.set(key, p);
      }
      p.setAttribute('class', edgeClass(e, key, emphasis, pathPairs));
      p.setAttribute('d', edgePath(e, lay.direction));
    }
    for (const [key, p] of edgeEls) {
      if (live.has(key)) continue;
      p.remove();
      edgeEls.delete(key);
    }
  }

  function flush() {
    frame = 0;
    viewport.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
    if (!pending) return;
    const { graph, lay, state } = pending;
    pending = null;
    layout = lay;
    const emphasis = state.emphasis instanceof Set ? state.emphasis : null;
    const path = Array.isArray(state.path) ? state.path : [];
    const pathPairs = new Set(path.slice(1).map((id, i) => pairKey(path[i], id)));
    drawNodes(graph, lay, state, emphasis, new Set(path));
    drawEdges(lay, emphasis, pathPairs);
    const cycles = Array.isArray(graph.cycles) ? graph.cycles : [];
    banner.hidden = !cycles.length;
    banner.textContent = cycles.length ? t('lm.cycle', { ids: cycles.map((c) => c.join(' → ')).join('; ') }) : '';
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  /** Scales and centres the whole layout into the host. */
  function fit(lay = layout) {
    if (!lay) return;
    const w = host.clientWidth || 800;
    const h = host.clientHeight || 500;
    const k = clampZoom(Math.min(FIT_MAX_ZOOM, (w - FIT_PAD * 2) / Math.max(1, lay.width), (h - FIT_PAD * 2) / Math.max(1, lay.height)));
    tf.k = k;
    tf.x = (w - lay.width * k) / 2;
    tf.y = (h - lay.height * k) / 2;
    schedule();
  }

  /** Zooms around a host-relative point (the host's centre by default). */
  function zoomBy(factor, cx, cy) {
    const px = Number.isFinite(cx) ? cx : host.clientWidth / 2;
    const py = Number.isFinite(cy) ? cy : host.clientHeight / 2;
    const k = clampZoom(tf.k * factor);
    tf.x = px - ((px - tf.x) * k) / tf.k;
    tf.y = py - ((py - tf.y) * k) / tf.k;
    tf.k = k;
    schedule();
  }

  /** Pans just enough to bring a node into view (keyboard focus). */
  function reveal(id) {
    const pos = layout && layout.nodes.find((n) => n.id === id);
    if (!pos) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    const left = tf.x + pos.x * tf.k;
    const top = tf.y + pos.y * tf.k;
    const right = left + pos.w * tf.k;
    const bottom = top + pos.h * tf.k;
    if (left < FIT_PAD) tf.x += FIT_PAD - left;
    else if (right > w - FIT_PAD) tf.x -= right - (w - FIT_PAD);
    if (top < FIT_PAD) tf.y += FIT_PAD - top;
    else if (bottom > h - FIT_PAD) tf.y -= bottom - (h - FIT_PAD);
    schedule();
  }

  const detach = bindPointer(root, host, handlers, { tf, schedule, zoomBy, reveal });

  return {
    /** Draws the graph at its layout on the next frame. */
    update(graph, lay, state = {}) {
      pending = { graph, lay, state };
      schedule();
    },
    fit,
    zoomBy,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    /** Moves keyboard focus to a node (after the pending frame drew it). */
    focusNode(id) {
      requestAnimationFrame(() => {
        const item = nodeEls.get(id);
        if (item) item.g.focus();
      });
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      detach();
      root.remove();
      banner.remove();
      nodeEls.clear();
      edgeEls.clear();
    },
  };
}

/** Pointer, wheel, keyboard and focus wiring of one view; returns the cleanup. */
function bindPointer(root, host, handlers, ctl) {
  const { tf, schedule, zoomBy, reveal } = ctl;
  const nodeOf = (target) => (target instanceof Element ? target.closest('.lm-node') : null);
  let drag = null;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y, moved: false, onNode: !!nodeOf(e.target) };
    if (!drag.onNode) root.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag || drag.onNode) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    drag.moved = true;
    root.classList.add('is-panning');
    tf.x = drag.tx + dx;
    tf.y = drag.ty + dy;
    schedule();
  };
  const onPointerUp = (e) => {
    if (!drag) return;
    const wasClick = !drag.moved && !drag.onNode && e.type === 'pointerup';
    drag = null;
    root.classList.remove('is-panning');
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    // A click on the empty background clears the selection.
    if (wasClick && handlers.onSelect) handlers.onSelect(null);
  };
  const onClick = (e) => {
    const n = nodeOf(e.target);
    if (n && handlers.onSelect) handlers.onSelect(n.dataset.id);
  };
  const onDblClick = (e) => {
    const n = nodeOf(e.target);
    if (n && handlers.onOpen) handlers.onOpen(n.dataset.id);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), e.clientX - rect.left, e.clientY - rect.top);
  };
  const onKeyDown = (e) => {
    const n = nodeOf(e.target);
    if (!n || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (handlers.onSelect) handlers.onSelect(n.dataset.id);
  };
  const onOver = (e) => {
    const n = nodeOf(e.target);
    if (n && handlers.onHover && !n.contains(e.relatedTarget)) handlers.onHover(n.dataset.id, n.getBoundingClientRect());
  };
  const onOut = (e) => {
    const n = nodeOf(e.target);
    if (n && handlers.onHover && !n.contains(e.relatedTarget)) handlers.onHover(null, null);
  };
  const onFocusIn = (e) => {
    const n = nodeOf(e.target);
    if (!n) return;
    reveal(n.dataset.id);
    // After the reveal's frame, so the tooltip sits at the node's new place.
    if (handlers.onHover) requestAnimationFrame(() => requestAnimationFrame(() => n.isConnected && handlers.onHover(n.dataset.id, n.getBoundingClientRect())));
  };
  const onFocusOut = (e) => {
    if (!nodeOf(e.relatedTarget) && handlers.onHover) handlers.onHover(null, null);
  };
  const listeners = [
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp], ['pointercancel', onPointerUp],
    ['click', onClick], ['dblclick', onDblClick], ['keydown', onKeyDown], ['mouseover', onOver], ['mouseout', onOut],
    ['focusin', onFocusIn], ['focusout', onFocusOut],
  ];
  for (const [type, fn] of listeners) root.addEventListener(type, fn);
  root.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    for (const [type, fn] of listeners) root.removeEventListener(type, fn);
    root.removeEventListener('wheel', onWheel);
  };
}
