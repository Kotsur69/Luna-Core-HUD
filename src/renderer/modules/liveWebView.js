// ============================================================================
// LunaCore - God Mode Live Web: the canvas view
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. One God Mode run as a living web (liveWebModel.js),
// laid out by a force simulation (liveWebPhysics.js) and painted on a
// Canvas 2D at devicePixelRatio (liveWebDraw.js). One reusable component,
// mounted in two places: the Ctrl+Shift+G God Mode tab (liveMapGodMode.js,
// Live Web | Dependencies) and the #orchestra board (orchestraLiveWeb.js,
// Board | Live Web).
//
//  - Feeds, only while shown: the work map's model (workmap.js
//    onWorkmapModel - the app's one subscription, shared) and the process
//    snapshot (bridge.subscribeSessionProcs, which polls only while someone
//    watches). hide() gives both back and cancels the animation frame.
//  - The requestAnimationFrame loop runs only while shown and only while
//    something moves: the layout cooling, particles, the camera fitting, a
//    drag. An overlap's glow breathes on a slow timer instead of 60 fps.
//  - Pan (drag the background), zoom (wheel, + / -, toolbar), drag a node,
//    click to select, double-click a file for its diff or a worker for its
//    tab. Keyboard: arrows walk the nodes, Enter goes into the inspector,
//    0 fits, Esc clears the selection.
//  - Tool calls a worker makes travel as particles along the edge to what
//    they touched (liveWebModel.js toolEvents / burstEdge).
//  - Reduced motion (prefers-reduced-motion, or the in-app motion axis off /
//    reduced): the layout is settled at once and drawn still - no particles,
//    no breathing glow, no animated fit.
//  - Layer filter toggles hide Files / Processes / Ports / Verify /
//    Subagents / MCP / Memory; the choice is remembered.
// Text reaches the DOM through textContent / setAttribute only; the canvas
// draws with fillText.
// ============================================================================

'use strict';

import { t } from './util.js';
import { writePref, ZOOM_STEP } from './liveMapHelpers.js';
import { toWorld, fitCamera, easeCamera, zoomAround, revealCamera, FIT_EASE } from './liveWebCamera.js';
import { buildWeb, filterWeb, toolEvents, burstEdge, parseHiddenLayers, hiddenLayersText, FILTER_LAYERS, MAX_WEB_NODES } from './liveWebModel.js';
import { createSim, setGraph, step, settle, isSettled, pin, unpin, bounds, positionOf } from './liveWebPhysics.js';
import { drawWeb, readPalette, nodeRadius } from './liveWebDraw.js';
import { inspectorContent, webLabel, layerName, filterName } from './liveWebInspector.js';
import { travelAllowed } from './workmap.js';
import { workmapModelState, onWorkmapModel } from './workmapFeed.js';
import { procListOf, snapshotSessionIds, mergeProcs } from './workmapSatellites.js';
import { openDiffModal } from './activefiles.js';

const STORAGE_HIDDEN = 'lunacore.liveWeb.hidden';
/** One physics step; frames run whole steps from an accumulator. */
const STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 3;
/** A longer gap (a hidden window, a breakpoint) is not caught up on. */
const MAX_FRAME_GAP_MS = 100;
const PARTICLE_MS = 750;
const PARTICLE_STAGGER_MS = 70;
const MAX_PARTICLES = 120;
/** The overlap glow's repaint pace while nothing else moves... */
const PULSE_TICK_MS = 125;
/** ...and it rests (drawn still) this long after the last change, so an idle run costs nothing. */
const PULSE_IDLE_MS = 20 * 1000;
/** Rebuilding the web from the feeds at most this often; particles still leave at once. */
const REBUILD_MIN_MS = 250;
const HIT_PAD_PX = 6;
const DRAG_SLOP_PX = 4;
const WHEEL_ZOOM_RATE = 0.0015;
const TIP_GAP_PX = 12;
const TIP_EDGE_PX = 4;
const MAX_DPR = 3;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolButton(cls, onClick) {
  const btn = el('button', `lm-tool ${cls}`.trim());
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function labelButton(btn, key) {
  btn.title = t(key);
  btn.setAttribute('aria-label', t(key));
}

const realClock = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

function motionNow() {
  let reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reduced = false;
  }
  return travelAllowed(reduced, document.documentElement.dataset.motion);
}

function storedHidden() {
  try {
    return window.localStorage.getItem(STORAGE_HIDDEN);
  } catch {
    // Storage refused (private mode, policy): start with every layer shown.
    return null;
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Swaps a panel's content without throwing keyboard focus to <body> (a live push rebuilds it). */
function replaceKeepingFocus(container, children) {
  const active = document.activeElement;
  const items = () => [...container.querySelectorAll('button')];
  const index = active && container.contains(active) ? items().indexOf(active) : -1;
  const scroll = container.scrollTop;
  container.replaceChildren(...children);
  container.scrollTop = scroll;
  if (index < 0) return;
  const list = items();
  const target = list[Math.min(index, list.length - 1)];
  if (target) target.focus();
}

/**
 * The Live Web component.
 * @param {{bridge?: object, getView?: () => (object|null), getRunLabel?: () => string,
 *   gotoWorker?: (sessionId: string) => void, showOnBoard?: (pkgId: string) => void,
 *   now?: () => number, setTimeout?: (fn: () => void, ms: number) => *, clearTimeout?: (id: *) => void}} deps
 *   bridge: window.lunacore (subscribeSessionProcs); getView: the run to show;
 *   now / setTimeout / clearTimeout: the monotonic ms clock and idle timers (real ones by default,
 *   injectable so tests can cross the rebuild throttle without sleeping)
 * @returns {{root: HTMLElement, show: () => void, hide: () => void, refresh: () => void,
 *   resetRun: () => void, onKey: (e: KeyboardEvent) => boolean, onLang: () => void, destroy: () => void}}
 */
export function createLiveWeb(deps = {}) {
  const bridge = deps.bridge && typeof deps.bridge === 'object' ? deps.bridge : {};
  const getView = typeof deps.getView === 'function' ? deps.getView : () => null;
  const getRunLabel = typeof deps.getRunLabel === 'function' ? deps.getRunLabel : () => '';
  const clock = typeof deps.now === 'function' ? deps.now : realClock;
  const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : (id) => clearTimeout(id);
  const actions = {
    gotoWorker: (sessionId) => (typeof deps.gotoWorker === 'function' ? deps.gotoWorker(sessionId) : undefined),
    showOnBoard: (pkgId) => (typeof deps.showOnBoard === 'function' ? deps.showOnBoard(pkgId) : undefined),
    showDiff: (path, sessionId) => {
      openDiffModal(path, sessionId).catch((err) => console.error('[liveweb] opening the diff failed:', err));
    },
  };
  let hidden = parseHiddenLayers(storedHidden());
  let sim = createSim();
  let full = null;
  let web = null;
  let nodes = new Map();
  let edgeById = new Map();
  let selectedId = null;
  let hoverId = null;
  // Layout -> screen: p * k + (x, y), CSS px (liveWebCamera.js); replaced, never mutated.
  let cam = { x: 0, y: 0, k: 1 };
  let autoFit = true;
  let size = { w: 0, h: 0, dpr: 1 };
  let palette = null;
  let particles = [];
  let prevTabs = new Map();
  const procs = new Map();
  let unsubModel = null;
  let unsubProcs = null;
  let shown = false;
  let dirty = true;
  // When the web was last rebuilt, and when its data last changed (clock()).
  let builtAt = 0;
  let changedAt = 0;
  let webSig = '';
  let raf = 0;
  // A wait while no frame runs: a rebuild still owed, or the next overlap glow breath.
  let idleTimer = 0;
  let lastTs = 0;
  let acc = 0;
  let drag = null;
  let sideSig = '';
  const dom = build();
  syncToolbar();

  // --- DOM ---------------------------------------------------------------------

  function build() {
    const root = el('div', 'lw');
    const bar = el('div', 'lm-toolbar lw-bar');
    bar.setAttribute('role', 'toolbar');
    const filters = el('div', 'lm-toolbar__group lw-filters');
    filters.setAttribute('role', 'group');
    const toggles = new Map();
    for (const layer of FILTER_LAYERS) {
      const btn = toolButton(`lw-filter is-${layer}`, () => toggleLayer(layer));
      toggles.set(layer, btn);
      filters.append(btn);
    }
    const viewGroup = el('div', 'lm-toolbar__group');
    const zoomOut = toolButton('is-icon', () => zoomBy(1 / ZOOM_STEP));
    const fit = toolButton('', fitNow);
    const zoomIn = toolButton('is-icon', () => zoomBy(ZOOM_STEP));
    zoomOut.textContent = '−';
    zoomIn.textContent = '+';
    viewGroup.append(zoomOut, fit, zoomIn);
    const info = el('span', 'lm-toolbar__info lw-info');
    bar.append(filters, viewGroup, info);
    const body = el('div', 'lw-body');
    const stage = el('div', 'lm-stage lw-stage');
    const canvas = el('canvas', 'lw-canvas');
    canvas.tabIndex = 0;
    // It takes focus and its own keys (arrows, Enter, + - 0): a widget, not a picture.
    canvas.setAttribute('role', 'application');
    const message = el('div', 'lm-stage__msg is-center');
    message.setAttribute('role', 'status');
    message.hidden = true;
    const tip = el('div', 'lw-tip');
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    const live = el('div', 'lw-sr');
    live.setAttribute('aria-live', 'polite');
    stage.append(canvas, message, tip, live);
    const side = el('aside', 'lm-side lw-side');
    side.hidden = true;
    body.append(stage, side);
    root.append(bar, body);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    // A capture lost without a pointerup (window blur, another pointer) must not leave a node pinned.
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    canvas.addEventListener('pointerleave', () => {
      if (!drag) setHover(null, null);
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    root.addEventListener('keydown', onRootKey);
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        measure();
        wake();
      })
      : null;
    if (resize) resize.observe(stage);
    return { root, bar, filters, toggles, zoomOut, fit, zoomIn, info, stage, canvas, ctx, message, tip, live, side, resize };
  }

  function syncToolbar() {
    dom.bar.setAttribute('aria-label', t('lm.web.toolbar'));
    dom.filters.setAttribute('aria-label', t('lm.web.filters'));
    for (const [layer, btn] of dom.toggles) {
      btn.textContent = filterName(layer);
      btn.setAttribute('aria-pressed', hidden.has(layer) ? 'false' : 'true');
      btn.title = t('lm.web.filterHint', { layer: filterName(layer) });
    }
    labelButton(dom.zoomOut, 'lm.tb.zoomOut');
    labelButton(dom.zoomIn, 'lm.tb.zoomIn');
    dom.fit.textContent = t('lm.tb.fit');
  }

  function measure() {
    const rect = dom.stage.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(MAX_DPR, window.devicePixelRatio || 1));
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    dom.canvas.width = Math.max(1, Math.round(w * dpr));
    dom.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  // --- data --------------------------------------------------------------------

  function workerSessions() {
    const view = getView();
    const list = view && Array.isArray(view.packages) ? view.packages : [];
    return new Set(list.map((p) => p && p.sessionId).filter((id) => typeof id === 'string' && id));
  }

  /** The feeds or the view may have changed: rebuild on a coming frame (throttled to REBUILD_MIN_MS). */
  function markDirty({ now = false } = {}) {
    dirty = true;
    // A change Mati made himself (filter, run, language) shows at once.
    if (now) builtAt = 0;
    wake();
  }

  function rebuild() {
    dirty = false;
    builtAt = clock();
    rebuildWeb();
    // Only a web that really changed wakes the overlap glow (a clock-tick refresh does not).
    const sig = `${web.nodes.length}|${web.edges.length}|${JSON.stringify(full.counts)}`;
    if (sig !== webSig) {
      webSig = sig;
      changedAt = builtAt;
    }
  }

  function rebuildWeb() {
    const state = workmapModelState();
    const view = getView();
    full = buildWeb({ view, tabs: state ? state.tabs : null, procs, runLabel: getRunLabel(), now: Date.now() });
    web = filterWeb(full, hidden);
    nodes = new Map(web.nodes.map((n) => [n.id, n]));
    edgeById = new Map(web.edges.map((e) => [e.id, e]));
    setGraph(sim, web.nodes, web.edges);
    if (selectedId && !nodes.has(selectedId)) selectedId = null;
    if (hoverId && !nodes.has(hoverId)) setHover(null, null);
    particles = particles.filter((p) => nodes.has(p.from) && nodes.has(p.to));
    paintChrome(view);
    renderSide();
  }

  function paintChrome(view) {
    const packages = view && Array.isArray(view.packages) ? view.packages.length : 0;
    const msg = !view ? t('lm.web.empty') : packages ? '' : t('lm.web.noPackages');
    dom.message.textContent = msg;
    dom.message.hidden = !msg;
    const c = full.counts;
    const summary = t('lm.web.summary', { workers: c.workers, files: c.files, overlaps: c.overlaps, processes: c.processes });
    dom.info.textContent = summary;
    dom.info.classList.toggle('is-warn', c.overlaps > 0);
    dom.canvas.setAttribute('aria-label', t('lm.web.aria', { summary }));
  }

  function renderSide() {
    const node = selectedId ? nodes.get(selectedId) : null;
    dom.side.hidden = !node;
    if (!node) {
      if (sideSig) dom.side.replaceChildren();
      sideSig = '';
      return;
    }
    const sig = JSON.stringify([window.i18n ? window.i18n.lang : '', node]);
    if (sig === sideSig) return;
    sideSig = sig;
    dom.side.setAttribute('aria-label', t('lm.web.sideLabel'));
    replaceKeepingFocus(dom.side, inspectorContent(node, {
      nodes,
      cap: MAX_WEB_NODES,
      actions,
      onSelect: (id) => select(id, { announce: true }),
      onClose: () => {
        select(null);
        dom.canvas.focus();
      },
    }));
  }

  // --- feeds (shown only) ------------------------------------------------------

  function onModel(state) {
    if (!shown) return;
    const tabs = state && state.tabs instanceof Map ? state.tabs : new Map();
    if (web && motionNow()) {
      for (const sid of web.bySession.keys()) {
        const prev = prevTabs.get(sid) || null;
        const next = tabs.get(sid) || null;
        if (!prev || prev === next) continue;
        for (const ev of toolEvents(prev, next)) spawn(burstEdge(web, sid, ev), ev.failed);
      }
    }
    prevTabs = new Map(tabs);
    markDirty();
  }

  function spawn(hit, failed) {
    const e = hit ? edgeById.get(hit.edge) : null;
    if (!e) return;
    const now = clock();
    changedAt = now;
    // Concurrent calls on one edge leave one after another, not on top of each other.
    const queued = particles.filter((p) => p.from === e.from && p.to === e.to && p.start > now - PARTICLE_MS / 2).length;
    particles.push({ from: e.from, to: e.to, reverse: hit.reverse, failed, start: now + queued * PARTICLE_STAGGER_MS });
    if (particles.length > MAX_PARTICLES) particles = particles.slice(particles.length - MAX_PARTICLES);
  }

  function onProcSnapshot(payload) {
    if (!shown || !payload || typeof payload !== 'object' || !payload.sessions || typeof payload.sessions !== 'object') return;
    // Never later than now: a time in the future would keep an exited process from ever fading.
    const at = Number.isFinite(payload.at) ? Math.min(payload.at, Date.now()) : Date.now();
    const listed = new Set(snapshotSessionIds(payload));
    const workers = workerSessions();
    for (const id of new Set([...listed, ...procs.keys()])) {
      if (!workers.has(id)) procs.delete(id);
      else procs.set(id, mergeProcs(procs.get(id) || null, listed.has(id) ? procListOf(payload, id) : [], at));
    }
    markDirty();
  }

  function startFeeds() {
    if (!unsubModel) unsubModel = onWorkmapModel(onModel);
    const state = workmapModelState();
    // Whatever happened while hidden is already in the counts; nothing travels for it.
    prevTabs = new Map(state && state.tabs instanceof Map ? state.tabs : []);
    if (!unsubProcs && typeof bridge.subscribeSessionProcs === 'function') {
      const unsub = bridge.subscribeSessionProcs(onProcSnapshot);
      unsubProcs = typeof unsub === 'function' ? unsub : null;
    }
  }

  function stopFeeds() {
    if (unsubModel) unsubModel();
    unsubModel = null;
    const unsub = unsubProcs;
    unsubProcs = null;
    // What was alive is unknown from here on; the next show starts from a fresh snapshot.
    procs.clear();
    if (unsub) unsub();
  }

  // --- camera (the math is liveWebCamera.js) -----------------------------------

  /** Moves the camera toward the fit (eased while motion is allowed); true while it still moves. */
  function approachFit(motion) {
    const target = fitCamera(bounds(sim), size);
    if (!target) return false;
    const next = easeCamera(cam, target, motion ? FIT_EASE : 1);
    cam = next.cam;
    return next.moving;
  }

  function fitNow() {
    autoFit = true;
    wake();
  }

  function zoomAt(sx, sy, factor) {
    cam = zoomAround(cam, sx, sy, factor);
    autoFit = false;
    wake();
  }

  const zoomBy = (factor) => zoomAt(size.w / 2, size.h / 2, factor);

  /** Pans a keyboard-picked node into view when it sits outside it. */
  function reveal(id) {
    const p = positionOf(sim, id);
    const next = p ? revealCamera(cam, p, size) : null;
    if (!next) return;
    cam = next;
    autoFit = false;
  }

  // --- picking -----------------------------------------------------------------

  function hitTest(sx, sy) {
    if (!web) return null;
    const p = toWorld(cam, sx, sy);
    let best = null;
    let bestD = Infinity;
    for (const n of web.nodes) {
      const q = positionOf(sim, n.id);
      if (!q) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= nodeRadius(n) + HIT_PAD_PX / cam.k && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function hideTip() {
    dom.tip.hidden = true;
  }

  function setHover(id, point) {
    if (id !== hoverId) {
      hoverId = id;
      dom.canvas.classList.toggle('is-pointer', !!id);
      wake();
    }
    const node = id ? nodes.get(id) : null;
    if (!node || !point) {
      hideTip();
      return;
    }
    const name = node.layer === 'worker' ? `${node.pkgId} · ${node.title}` : webLabel(node);
    dom.tip.replaceChildren(el('span', 'lw-tip__kind', layerName(node.layer)), el('span', 'lw-tip__name', name));
    dom.tip.classList.toggle('is-warn', !!node.overlap);
    dom.tip.hidden = false;
    const x = Math.min(point.x + TIP_GAP_PX, size.w - dom.tip.offsetWidth - TIP_EDGE_PX);
    const y = Math.min(point.y + TIP_GAP_PX, size.h - dom.tip.offsetHeight - TIP_EDGE_PX);
    dom.tip.style.transform = `translate(${Math.round(Math.max(TIP_EDGE_PX, x))}px, ${Math.round(Math.max(TIP_EDGE_PX, y))}px)`;
  }

  function select(id, { announce = false } = {}) {
    const next = id && nodes.has(id) ? id : null;
    if (next === selectedId) return;
    selectedId = next;
    renderSide();
    if (announce) {
      const node = next ? nodes.get(next) : null;
      dom.live.textContent = node ? t('lm.web.selected', { layer: layerName(node.layer), name: node.layer === 'worker' ? node.pkgId : webLabel(node) }) : '';
    }
    wake();
  }

  function cycle(delta) {
    const list = web ? web.nodes : [];
    if (!list.length) return;
    const i = selectedId ? list.findIndex((n) => n.id === selectedId) : -1;
    const at = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    select(list[at].id, { announce: true });
    reveal(list[at].id);
  }

  // --- input -------------------------------------------------------------------

  function localPoint(e) {
    const r = dom.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    // One drag at a time: a second pointer (touch, pen) must not orphan a pinned node.
    if (e.button !== 0 || drag) return;
    const p = localPoint(e);
    const hit = hitTest(p.x, p.y);
    drag = { id: hit ? hit.id : null, x0: p.x, y0: p.y, camX: cam.x, camY: cam.y, moved: false };
    if (typeof dom.canvas.setPointerCapture === 'function') dom.canvas.setPointerCapture(e.pointerId);
    dom.canvas.focus({ preventScroll: true });
  }

  function onPointerMove(e) {
    const p = localPoint(e);
    if (!drag) {
      const hit = hitTest(p.x, p.y);
      setHover(hit ? hit.id : null, p);
      return;
    }
    if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) < DRAG_SLOP_PX) return;
    drag.moved = true;
    autoFit = false;
    hideTip();
    if (drag.id) {
      const w = toWorld(cam, p.x, p.y);
      pin(sim, drag.id, w.x, w.y);
    } else {
      cam = { k: cam.k, x: drag.camX + (p.x - drag.x0), y: drag.camY + (p.y - drag.y0) };
    }
    wake();
  }

  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.id && d.moved) unpin(sim, d.id);
    if (!d.moved) select(d.id);
    wake();
  }

  function onPointerCancel() {
    if (drag && drag.id) unpin(sim, drag.id);
    drag = null;
    wake();
  }

  function onWheel(e) {
    e.preventDefault();
    const p = localPoint(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * WHEEL_ZOOM_RATE));
  }

  function onDoubleClick(e) {
    const p = localPoint(e);
    const n = hitTest(p.x, p.y);
    if (!n) return;
    if (n.layer === 'file') {
      const w = n.workers.find((x) => x.sessionId);
      if (w) actions.showDiff(n.path, w.sessionId);
    } else if (n.layer === 'worker' && n.sessionId && n.hasTab) {
      actions.gotoWorker(n.sessionId);
    }
  }

  /** Esc clears the selection first (true = used). The hosts call this before closing. */
  function onKey(e) {
    if (!e || e.key !== 'Escape' || !selectedId) return false;
    select(null, { announce: true });
    dom.canvas.focus();
    return true;
  }

  function canvasKey(key) {
    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
        cycle(1);
        return true;
      case 'ArrowLeft':
      case 'ArrowUp':
        cycle(-1);
        return true;
      case 'Enter': {
        const first = dom.side.querySelector('.lm-side__actions button, button.lm-side__id');
        if (first) first.focus();
        return !!first;
      }
      case '+':
      case '=':
        zoomBy(ZOOM_STEP);
        return true;
      case '-':
      case '_':
        zoomBy(1 / ZOOM_STEP);
        return true;
      case '0':
        fitNow();
        return true;
      default:
        return false;
    }
  }

  function onRootKey(e) {
    if (e.defaultPrevented) return;
    let used = false;
    if (e.key === 'Escape') used = onKey(e);
    else if (e.target === dom.canvas && !e.ctrlKey && !e.metaKey && !e.altKey) used = canvasKey(e.key);
    if (!used) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function toggleLayer(layer) {
    const next = new Set(hidden);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    hidden = next;
    writePref(storage(), STORAGE_HIDDEN, hiddenLayersText(hidden));
    syncToolbar();
    markDirty({ now: true });
  }

  // --- the loop ----------------------------------------------------------------

  function clearIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = 0;
  }

  function wake() {
    if (!shown || raf) return;
    clearIdle();
    raf = requestAnimationFrame(frame);
  }

  /** Nothing moves: wait for an owed rebuild or the next glow breath, whichever is sooner. */
  function scheduleIdle(motion) {
    const now = clock();
    const owed = dirty ? Math.max(0, REBUILD_MIN_MS - (now - builtAt)) : Infinity;
    const breathing = motion && web && now - changedAt < PULSE_IDLE_MS && web.nodes.some((n) => n.overlap);
    const wait = Math.min(owed, breathing ? PULSE_TICK_MS : Infinity);
    if (!Number.isFinite(wait) || idleTimer) return;
    idleTimer = setTimer(() => {
      idleTimer = 0;
      wake();
    }, wait);
  }

  function advance(ts, motion) {
    if (motion) {
      const dt = lastTs ? Math.min(Math.max(0, ts - lastTs), MAX_FRAME_GAP_MS) : STEP_MS;
      lastTs = ts;
      acc += dt;
      let n = 0;
      while (acc >= STEP_MS && n < MAX_STEPS_PER_FRAME) {
        step(sim, 1);
        acc -= STEP_MS;
        n += 1;
      }
      if (n === MAX_STEPS_PER_FRAME) acc = 0;
      return;
    }
    // Reduced motion: the layout is shown at rest. A node held by a drag stays where the pointer puts it.
    lastTs = 0;
    acc = 0;
    particles = [];
    if (!(drag && drag.id)) settle(sim);
  }

  function paint(now, motion) {
    if (!dom.ctx || !web || !size.w || !size.h) return;
    if (!palette) palette = readPalette(dom.root);
    const moving = particles.filter((p) => now >= p.start).map((p) => ({ ...p, progress: Math.min(1, (now - p.start) / PARTICLE_MS) }));
    drawWeb(dom.ctx, {
      web, nodes, pos: (id) => positionOf(sim, id), cam, dpr: size.dpr, width: size.w, height: size.h,
      pal: palette, time: now, motion, selectedId, hoverId, labelOf: webLabel, particles: moving,
    });
  }

  function frame(ts) {
    raf = 0;
    if (!shown) return;
    if (dirty && (!web || clock() - builtAt >= REBUILD_MIN_MS)) rebuild();
    if (!size.w || !size.h) measure();
    const motion = motionNow();
    advance(ts, motion);
    const fitting = autoFit ? approachFit(motion) : false;
    const now = clock();
    particles = particles.filter((p) => now - p.start < PARTICLE_MS);
    paint(now, motion);
    const busy = !isSettled(sim) || particles.length > 0 || fitting;
    if (busy && motion) {
      raf = requestAnimationFrame(frame);
      return;
    }
    lastTs = 0;
    acc = 0;
    scheduleIdle(motion);
  }

  // --- the component's contract ------------------------------------------------

  /** Everything that runs stops: the frame, the idle timer, both feeds, a drag in progress. */
  function hide() {
    shown = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearIdle();
    stopFeeds();
    particles = [];
    if (drag && drag.id) unpin(sim, drag.id);
    drag = null;
    setHover(null, null);
  }

  return {
    root: dom.root,
    show() {
      if (shown) return;
      shown = true;
      // The theme may have changed while hidden.
      palette = null;
      measure();
      startFeeds();
      autoFit = true;
      lastTs = 0;
      acc = 0;
      changedAt = clock();
      markDirty({ now: true });
    },
    hide,
    /** The run view may have changed (a push, the clock tick). */
    refresh() {
      markDirty();
    },
    /** Another run on screen: a fresh layout, no selection, no particles of the old one. */
    resetRun() {
      sim = createSim();
      selectedId = null;
      hoverId = null;
      particles = [];
      autoFit = true;
      webSig = '';
      renderSide();
      markDirty({ now: true });
    },
    onKey,
    onLang() {
      sideSig = '';
      syncToolbar();
      markDirty({ now: true });
    },
    destroy() {
      hide();
      if (dom.resize) dom.resize.disconnect();
    },
  };
}
