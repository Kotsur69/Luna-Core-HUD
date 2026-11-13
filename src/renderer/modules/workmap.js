// ============================================================================
// LunaCore - Live map (Ctrl+Shift+G): the Sessions tab, the work map
// ----------------------------------------------------------------------------
// What the session in the active tab is doing, drawn on top of the pure model
// in workmapmodel.js (docs/untouched_docs/rag-stylememory.md, "Bonus"): the
// model in the centre with its context ring, a station per kind of tool call
// on a circle around it (name + count), a pulse travelling out to a station
// when a call starts and back when it ends, failed calls in red, and a
// Memory station drawn as a hexagon so it reads apart from the rest.
//
//  - One subscription per app (createSessionsTab runs once, from liveMap.js),
//    on the push feeds sessions.js already listens to: no new IPC, no polling,
//    no tokens. The map only paints while its tab shows.
//  - The SVG is built once; a repaint writes attributes and text in place,
//    batched to one animation frame however many events arrived.
//  - Pulses are Web Animations on reused dots, and only when motion is
//    allowed (prefers-reduced-motion and the in-app motion axis); otherwise
//    the busy spoke and station are highlighted and nothing travels.
//  - Data reaches the DOM through textContent / setAttribute only.
//  - The Memory station shows how many memory_search / memory_get /
//    memory_verify / memory_propose calls the session made (the model's
//    memoryCalls) and a "card loaded" mark. The mark comes from the tab list
//    main.js already pushes (sessionSummary's `memoryCard`), through
//    setMemoryStationInfo(), which stays the station's extension point.
//    The counts are calls started in this tab while the app ran, failed ones
//    included; `luna memory stats` counts logged successes per tab start, so
//    the two numbers can differ.
// The top half is pure (geometry, deltas, formatting) for test/workmap.test.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { tokenMs, tokenEase, EXIT_RATIO } from './motion.js';
import { truncate } from './liveMapHelpers.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { STATIONS, MEMORY_CALLS, subscribe, activeTabState, createTabState } from './workmapmodel.js';

// ---- geometry and pure helpers (tested) --------------------------------------

/** The map's own coordinate space; the SVG scales it into the stage. */
export const VIEW = Object.freeze({ w: 960, h: 600 });
export const CENTER = Object.freeze({ x: 480, y: 300 });
export const CORE_R = 68;
export const RING_R = 82;
export const ORBIT_R = 218;
export const STATION_R = 36;
// Gaps between a spoke's ends and the shapes it joins.
const SPOKE_GAP_CORE = 12;
const SPOKE_GAP_STATION = 6;
const MODEL_LABEL_CHARS = 16;
// Where the "card loaded" words sit, from the station's upper-right corner (beside the mark).
const CARD_LABEL_DX = 14;
const CARD_LABEL_DY = 4;
const ERROR_TITLE_CHARS = 160;
const SVG_NS = 'http://www.w3.org/2000/svg';
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Stations evenly on a circle, clockwise from `startDeg` (-90 = 12 o'clock).
 * @param {string[]} ids
 * @param {{cx?:number, cy?:number, r?:number, startDeg?:number}} [opts]
 * @returns {Array<{id:string, x:number, y:number, angleDeg:number}>}
 */
export function stationLayout(ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const cx = Number.isFinite(opts.cx) ? opts.cx : CENTER.x;
  const cy = Number.isFinite(opts.cy) ? opts.cy : CENTER.y;
  const r = Number.isFinite(opts.r) ? opts.r : ORBIT_R;
  const start = Number.isFinite(opts.startDeg) ? opts.startDeg : -90;
  const step = list.length ? 360 / list.length : 0;
  return list.map((id, i) => {
    const angleDeg = start + step * i;
    const rad = (angleDeg * Math.PI) / 180;
    return { id, x: round2(cx + r * Math.cos(rad)), y: round2(cy + r * Math.sin(rad)), angleDeg };
  });
}

/**
 * Baselines of a station's two text lines, on the side away from the centre
 * so the spoke never runs through them: above the disc in the upper half,
 * below it otherwise (the side stations' spokes are horizontal).
 * @param {{x:number, y:number}} pos
 * @returns {{name:number, status:number}}
 */
export function stationLabelY(pos) {
  if (pos.y < CENTER.y - 1) return { name: pos.y - STATION_R - 25, status: pos.y - STATION_R - 10 };
  return { name: pos.y + STATION_R + 19, status: pos.y + STATION_R + 34 };
}

/**
 * The segment between two circles' edges, along the line joining their centres.
 * @param {{x:number, y:number}} from
 * @param {{x:number, y:number}} to
 * @param {number} fromR clearance at `from`
 * @param {number} toR clearance at `to`
 * @returns {{x1:number, y1:number, x2:number, y2:number}}
 */
export function spokeOf(from, to, fromR, toR) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: round2(from.x + ux * fromR),
    y1: round2(from.y + uy * fromR),
    x2: round2(to.x - ux * toR),
    y2: round2(to.y - uy * toR),
  };
}

/**
 * The stroke-dasharray that fills `fraction` of a circle of radius `r`.
 * @param {number|null} fraction 0..1 (clamped; null / junk = empty)
 * @param {number} r
 */
export function ringDash(fraction, r) {
  const circumference = 2 * Math.PI * r;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return { circumference: round2(circumference), dasharray: `${round2(circumference * f)} ${round2(circumference)}` };
}

/**
 * The context share (0..1) of a tab, or null without a sample. tokens / limit
 * when both are known (observer.js derives `percent` from them); else the
 * percent field, read as a fraction when it is 0..1 - observer.js sends 0..1,
 * while workmapmodel.js documents (and clamps to) 0..100.
 * @param {{contextTokens?:number|null, contextLimit?:number|null, contextPercent?:number|null}|null} tab
 * @returns {number|null}
 */
export function contextFraction(tab) {
  if (!tab || typeof tab !== 'object') return null;
  const { contextTokens: tokens, contextLimit: limit, contextPercent: pct } = tab;
  if (Number.isFinite(tokens) && Number.isFinite(limit) && limit > 0) return Math.min(1, Math.max(0, tokens / limit));
  if (!Number.isFinite(pct)) return null;
  return Math.min(1, Math.max(0, pct <= 1 ? pct : pct / 100));
}

/** The ring's band, with the HUD's own thresholds (thresholds.js). */
export function contextLevel(fraction) {
  if (!Number.isFinite(fraction)) return 'none';
  if (fraction >= CTX_WARN_HIGH) return 'high';
  if (fraction >= CTX_WARN_MID) return 'mid';
  return 'calm';
}

/**
 * Calls that started / ended / failed per station between two paints of the
 * same tab. `prev` null (first paint, another tab) means nothing moved.
 * @param {{stations:object}|null} prev
 * @param {{stations:object}} next
 * @returns {Record<string, {started:number, ended:number, failed:number}>}
 */
export function callDeltas(prev, next) {
  const out = {};
  for (const id of STATIONS) {
    const a = prev && prev.stations ? prev.stations[id] : null;
    const b = next && next.stations ? next.stations[id] : null;
    if (!a || !b) {
      out[id] = { started: 0, ended: 0, failed: 0 };
      continue;
    }
    const started = Math.max(0, b.total - a.total);
    out[id] = {
      started,
      ended: Math.max(0, a.inFlight + started - b.inFlight),
      failed: Math.max(0, b.errors - a.errors),
    };
  }
  return out;
}

/** Travelling pulses only when neither the OS nor the in-app motion axis asks for less. */
export function travelAllowed(prefersReduced, motionAttr) {
  return prefersReduced !== true && motionAttr !== 'off' && motionAttr !== 'reduced';
}

/** "950", "1.2k", "34k" - a station count that fits its disc. */
export function compactCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.floor(n / 1000)}k`;
}

/**
 * Memory station extras as given to setMemoryStationInfo(), validated.
 * @param {unknown} raw {memories?: number, cardLoaded?: boolean}
 * @returns {{memories:number|null, cardLoaded:boolean|null}|null} null = nothing usable
 */
export function memoryInfoOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const memories = Number.isSafeInteger(raw.memories) && raw.memories >= 0 ? raw.memories : null;
  const cardLoaded = typeof raw.cardLoaded === 'boolean' ? raw.cardLoaded : null;
  return memories === null && cardLoaded === null ? null : { memories, cardLoaded };
}

/**
 * The memory tools a session called, for the station's status line: only the
 * tools called at least once, in MEMORY_CALLS order.
 * @param {unknown} calls TabState.memoryCalls
 * @returns {Array<{kind:string, n:number}>}
 */
export function memoryCallParts(calls) {
  if (!calls || typeof calls !== 'object') return [];
  return MEMORY_CALLS.filter((kind) => Number.isSafeInteger(calls[kind]) && calls[kind] > 0).map((kind) => ({ kind, n: calls[kind] }));
}

/**
 * The card flags of a pushed tab list: `memoryCard` true / false as main.js
 * reports it, null when it does not know (not a `claude` tab, not started).
 * @param {unknown} list sessions:update `sessions`
 * @returns {Map<string, boolean|null>} tab id -> flag
 */
export function cardFlagsOf(list) {
  const flags = new Map();
  if (!Array.isArray(list)) return flags;
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    flags.set(m.id, typeof m.memoryCard === 'boolean' ? m.memoryCard : null);
  }
  return flags;
}

// ---- Memory station extension point --------------------------------------------

const memoryInfo = new Map();
const memoryListeners = new Set();

/**
 * Per-session facts for the Memory station: how many memories the session
 * used, and whether its memory card was loaded at tab start. Pass null (or
 * nothing usable) to clear. The map repaints if it shows that session.
 * @param {string} sessionId
 * @param {{memories?: number, cardLoaded?: boolean}|null} info
 */
export function setMemoryStationInfo(sessionId, info) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const clean = memoryInfoOf(info);
  if (clean) memoryInfo.set(sessionId, clean);
  else memoryInfo.delete(sessionId);
  for (const fn of memoryListeners) fn(sessionId);
}

/** What setMemoryStationInfo() last stored for a session, or null. */
export const memoryStationInfo = (sessionId) => memoryInfo.get(sessionId) || null;

/**
 * Takes the card flags of a pushed tab list into the station info, keeping
 * any memory count already there. A tab no longer in the list is forgotten.
 * Only a flag that changed notifies the map.
 * @param {unknown} list sessions:update `sessions`
 */
export function applyCardFlags(list) {
  const flags = cardFlagsOf(list);
  for (const id of [...memoryInfo.keys()]) if (!flags.has(id)) setMemoryStationInfo(id, null);
  for (const [id, cardLoaded] of flags) {
    const known = memoryInfo.get(id) || null;
    if ((known ? known.cardLoaded : null) === cardLoaded) continue;
    setMemoryStationInfo(id, { memories: known ? known.memories : undefined, cardLoaded: cardLoaded === null ? undefined : cardLoaded });
  }
}

// ---- DOM -----------------------------------------------------------------------

function svg(tag, cls, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};
const setAttr = (node, key, value) => {
  const v = String(value);
  if (node.getAttribute(key) !== v) node.setAttribute(key, v);
};

/** A flat-topped hexagon's points around (x, y). */
function hexPoints(x, y, r) {
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i;
    pts.push(`${round2(x + r * Math.cos(a))},${round2(y + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}

function buildCore() {
  const g = svg('g', 'wm-core', { role: 'img' });
  const disc = svg('circle', 'wm-core__disc', { cx: CENTER.x, cy: CENTER.y, r: CORE_R });
  const track = svg('circle', 'wm-ring__track', { cx: CENTER.x, cy: CENTER.y, r: RING_R });
  const fill = svg('circle', 'wm-ring__fill', { cx: CENTER.x, cy: CENTER.y, r: RING_R, transform: `rotate(-90 ${CENTER.x} ${CENTER.y})` });
  const model = svg('text', 'wm-core__model', { x: CENTER.x, y: CENTER.y - 14 });
  const pct = svg('text', 'wm-core__pct', { x: CENTER.x, y: CENTER.y + 14 });
  const sub = svg('text', 'wm-core__sub', { x: CENTER.x, y: CENTER.y + 34 });
  g.append(track, fill, disc, model, pct, sub);
  return { g, fill, model, pct, sub };
}

function buildStation(pos) {
  const memory = pos.id === 'memory';
  const g = svg('g', `wm-station is-${pos.id}`, { role: 'img' });
  const title = svg('title');
  const halo = svg('circle', 'wm-station__halo', { cx: pos.x, cy: pos.y, r: STATION_R + 7 });
  const disc = memory
    ? svg('polygon', 'wm-station__disc', { points: hexPoints(pos.x, pos.y, STATION_R + 3) })
    : svg('circle', 'wm-station__disc', { cx: pos.x, cy: pos.y, r: STATION_R });
  const count = svg('text', 'wm-station__count', { x: pos.x, y: pos.y + 6 });
  const ys = stationLabelY(pos);
  const name = svg('text', 'wm-station__name', { x: pos.x, y: ys.name });
  const status = svg('text', 'wm-station__status', { x: pos.x, y: ys.status });
  g.append(title, halo, disc, count, name, status);
  const parts = { g, title, disc, count, name, status, card: null, cardLabel: null };
  if (memory) {
    // The "card loaded" mark: filled = loaded, hollow = not loaded, hidden = unknown.
    const card = svg('rect', 'wm-card', { x: pos.x + STATION_R - 4, y: pos.y - STATION_R - 6, width: 12, height: 12, rx: 2, transform: `rotate(45 ${pos.x + STATION_R + 2} ${pos.y - STATION_R})` });
    // Said in words too, never by the mark's fill alone.
    const cardLabel = svg('text', 'wm-card__label', { x: pos.x + STATION_R + CARD_LABEL_DX, y: pos.y - STATION_R + CARD_LABEL_DY });
    g.append(card, cardLabel);
    parts.card = card;
    parts.cardLabel = cardLabel;
  }
  return parts;
}

function buildMap() {
  const root = svg('svg', 'wm-map', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, preserveAspectRatio: 'xMidYMid meet', role: 'group' });
  const spokes = svg('g', 'wm-spokes');
  const packets = svg('g', 'wm-packets', { 'aria-hidden': 'true' });
  const stationLayer = svg('g', 'wm-stations');
  const core = buildCore();
  const items = new Map();
  for (const pos of stationLayout(STATIONS)) {
    const s = spokeOf(CENTER, pos, RING_R + SPOKE_GAP_CORE, STATION_R + SPOKE_GAP_STATION);
    const spoke = svg('line', 'wm-spoke', s);
    const packet = svg('circle', `wm-packet is-${pos.id}`, { cx: 0, cy: 0, r: 5 });
    spokes.append(spoke);
    packets.append(packet);
    const station = buildStation(pos);
    stationLayer.append(station.g);
    items.set(pos.id, { ...station, spoke, packet, seg: s, anim: null });
  }
  root.append(spokes, packets, core.g, stationLayer);
  return { root, core, items };
}

// ---- the tab -------------------------------------------------------------------

const IDLE_TAB = createTabState();

function motionNow() {
  let reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reduced = false;
  }
  return travelAllowed(reduced, document.documentElement.dataset.motion);
}

/** One dot along a spoke: out = core -> station (a call started), back = station -> core. */
function sendPacket(item, outward, failed) {
  const ms = tokenMs('--dur-normal');
  if (!ms || typeof item.packet.animate !== 'function') return;
  const { x1, y1, x2, y2 } = item.seg;
  const [from, to] = outward ? [[x1, y1], [x2, y2]] : [[x2, y2], [x1, y1]];
  if (item.anim) item.anim.cancel();
  item.packet.classList.toggle('is-failed', !!failed);
  item.anim = item.packet.animate(
    [
      { transform: `translate(${from[0]}px, ${from[1]}px)`, opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.8 },
      { transform: `translate(${to[0]}px, ${to[1]}px)`, opacity: 0 },
    ],
    outward
      ? { duration: ms, easing: tokenEase('--ease-smooth') }
      // The return reads as the call settling: shorter, like any exit.
      : { duration: Math.round(ms * EXIT_RATIO), easing: tokenEase('--ease-sharp') },
  );
}

/**
 * The Sessions tab. Subscribes at once, so the counts start with the app.
 * @param {{bridge?: object, getActiveSessionId?: () => (string|null)}} deps
 *   bridge: window.lunacore (onTools/onMcp/onContext/onTurnEnd/onSessions/onRestarted)
 */
export function createSessionsTab(deps = {}) {
  const bridge = deps.bridge && typeof deps.bridge === 'object' ? deps.bridge : {};
  const getActive = typeof deps.getActiveSessionId === 'function' ? deps.getActiveSessionId : () => null;
  const labels = new Map();
  let dom = null;
  let shown = false;
  let frame = 0;
  let lastId = null;
  let lastTab = null;
  let seededLabels = false;

  const renderSoon = () => {
    if (shown && dom && !frame) frame = requestAnimationFrame(render);
  };
  // App-lifetime subscriptions, taken once here and never per show: the
  // bridge's onTools / onMcp / onContext / onTurnEnd / onSessions /
  // onRestarted (preload.js) return no unsubscribe. While the tab is hidden
  // they only fold events into the model - no DOM work, frame or timer.
  // liveMap.js never remounts a tab, so unmount() leaves them in place.
  const sub = subscribe(bridge, renderSoon, { getActiveSessionId: getActive });

  if (typeof bridge.onSessions === 'function') {
    bridge.onSessions((payload) => {
      const list = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
      // The pushed list is the source of truth: a closed tab's name goes with it.
      labels.clear();
      rememberLabels(list);
      applyCardFlags(list);
      const live = new Set(list.map((m) => m && m.id).filter(Boolean));
      for (const id of sub.getState().tabs.keys()) if (!live.has(id)) sub.dispatch({ channel: 'tab:closed', payload: { sessionId: id } });
      if (payload && typeof payload.activeSessionId === 'string') sub.dispatch({ channel: 'tab:active', payload: { sessionId: payload.activeSessionId } });
      renderSoon();
    });
  }
  if (typeof bridge.onRestarted === 'function') {
    bridge.onRestarted((profile) => {
      if (profile && typeof profile.sessionId === 'string') sub.dispatch({ channel: 'tab:reset', payload: { sessionId: profile.sessionId } });
    });
  }
  memoryListeners.add((sessionId) => {
    if (sessionId === sub.getState().activeTab) renderSoon();
  });

  function rememberLabels(list) {
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const label = [m.folder, m.profileLabel, m.id].find((v) => typeof v === 'string' && v);
      labels.set(m.id, label);
    }
  }

  /** Tab names arrive with the next sessions:update; one read fills them in before that (retried on the next show if it fails). */
  async function seedLabels() {
    if (seededLabels || typeof bridge.getSessions !== 'function') return;
    seededLabels = true;
    try {
      const res = await bridge.getSessions();
      if (res && Array.isArray(res.sessions)) {
        rememberLabels(res.sessions);
        applyCardFlags(res.sessions);
      } else {
        seededLabels = false;
      }
      renderSoon();
    } catch (err) {
      seededLabels = false;
      console.error('[livemap] sessions map: reading the tab list failed:', err);
    }
  }

  function build(panel) {
    const head = el('div', 'wm-head');
    const tabName = el('span', 'wm-head__tab');
    const summary = el('span', 'wm-head__sum');
    const turns = el('span', 'wm-head__turns');
    head.append(tabName, summary, turns);
    const stage = el('div', 'lm-stage wm-stage');
    const map = buildMap();
    const message = el('div', 'lm-stage__msg');
    message.setAttribute('role', 'status');
    stage.append(map.root, message);
    const gap = el('p', 'wm-gap');
    panel.classList.add('wm-panel');
    panel.replaceChildren(head, stage, gap);
    dom = { head, tabName, summary, turns, message, gap, ...map };
  }

  function paintCore(tab) {
    const { core } = dom;
    const fraction = contextFraction(tab);
    const level = contextLevel(fraction);
    const modelText = tab.modelLabel || tab.model || t('lm.wm.modelUnknown');
    setText(core.model, truncate(modelText, MODEL_LABEL_CHARS));
    setText(core.pct, fraction === null ? '-' : `${Math.round(fraction * 100)}%`);
    const tokens = Number.isFinite(tab.contextTokens) && Number.isFinite(tab.contextLimit)
      ? `${compactCount(tab.contextTokens)} / ${compactCount(tab.contextLimit)}`
      : t('lm.wm.ctxNone');
    setText(core.sub, tokens);
    setAttr(core.fill, 'stroke-dasharray', ringDash(fraction, RING_R).dasharray);
    setAttr(core.g, 'class', `wm-core is-${level}`);
    setAttr(core.g, 'aria-label', t('lm.wm.coreAria', { model: modelText, pct: fraction === null ? t('lm.wm.ctxNone') : `${Math.round(fraction * 100)}%` }));
  }

  /** The Memory station's own extras: per-tool counts in the status line, the card mark in words. */
  function memoryExtras(item, calls, info) {
    const loaded = info ? info.cardLoaded : null;
    setAttr(item.card, 'class', `wm-card${loaded === true ? ' is-on' : loaded === false ? ' is-off' : ' is-unknown'}`);
    setText(item.cardLabel, loaded === true ? t('lm.wm.cardLoaded') : '');
    const cardText = loaded === true ? t('lm.wm.cardLoaded') : loaded === false ? t('lm.wm.cardNone') : '';
    const parts = memoryCallParts(calls).map(({ kind, n }) => t(`lm.wm.mem.${kind}`, { n }));
    if (info && info.memories !== null) parts.unshift(t('lm.wm.memories', { n: info.memories }));
    return { parts, cardText };
  }

  function paintStation(id, item, st, info, moved, travel, calls) {
    const name = t(`lm.wm.station.${id}`);
    const extras = item.card ? memoryExtras(item, calls, info) : { parts: [], cardText: '' };
    const parts = [...extras.parts];
    if (st.inFlight > 0) parts.push(t('lm.wm.running', { n: st.inFlight }));
    if (st.errors > 0) parts.push(t('lm.wm.failed', { n: st.errors }));
    setText(item.count, compactCount(st.total));
    setText(item.name, name);
    setText(item.status, parts.join(' · '));
    const cls = ['wm-station', `is-${id}`];
    if (st.inFlight > 0) cls.push('is-busy');
    if (st.errors > 0) cls.push('has-errors');
    if (st.total === 0) cls.push('is-idle');
    setAttr(item.g, 'class', cls.join(' '));
    setAttr(item.status, 'class', `wm-station__status${st.errors > 0 ? ' is-bad' : ''}`);
    setAttr(item.spoke, 'class', `wm-spoke${st.inFlight > 0 ? ' is-busy' : ''}`);
    const aria = t('lm.wm.stationAria', { name, calls: st.total, running: st.inFlight, failed: st.errors });
    setAttr(item.g, 'aria-label', [aria, ...extras.parts, extras.cardText].filter(Boolean).join(', '));
    const lastError = st.lastError && st.lastError.message ? t('lm.wm.lastError', { msg: truncate(st.lastError.message, ERROR_TITLE_CHARS) }) : '';
    setText(item.title, [name, extras.cardText, lastError].filter(Boolean).join('\n'));
    if (!travel) return;
    if (moved.started > 0) sendPacket(item, true, false);
    else if (moved.ended > 0) sendPacket(item, false, moved.failed > 0);
  }

  function paintHead(activeId, tab) {
    const totals = STATIONS.reduce(
      (acc, id) => ({ calls: acc.calls + tab.stations[id].total, running: acc.running + tab.stations[id].inFlight, failed: acc.failed + tab.stations[id].errors }),
      { calls: 0, running: 0, failed: 0 },
    );
    setText(dom.tabName, activeId ? t('lm.wm.following', { name: labels.get(activeId) || activeId }) : '');
    setText(dom.summary, activeId ? t('lm.wm.summary', totals) : '');
    setText(dom.turns, activeId && tab.turns ? t('lm.wm.turns', { n: tab.turns }) : '');
  }

  function render() {
    frame = 0;
    if (!dom || !shown) return;
    sub.prune();
    const state = sub.getState();
    const activeId = state.activeTab;
    const data = activeTabState(state);
    const tab = data || IDLE_TAB;
    const deltas = activeId !== null && activeId === lastId ? callDeltas(lastTab, tab) : callDeltas(null, tab);
    lastId = activeId;
    lastTab = tab;
    const travel = motionNow();
    const info = activeId ? memoryStationInfo(activeId) : null;
    paintHead(activeId, tab);
    paintCore(tab);
    for (const id of STATIONS) paintStation(id, dom.items.get(id), tab.stations[id], info, deltas[id], travel, tab.memoryCalls);
    let msg = '';
    if (!activeId) msg = t('lm.wm.noTab');
    else if (!data) msg = t('lm.wm.waiting');
    setText(dom.message, msg);
    dom.message.hidden = !msg;
    setAttr(dom.root, 'aria-label', t('lm.wm.label'));
    setText(dom.gap, t('lm.wm.gap'));
  }

  function stopPackets() {
    if (!dom) return;
    for (const item of dom.items.values()) {
      if (item.anim) item.anim.cancel();
      item.anim = null;
    }
  }

  // --- the tab contract (liveMap.js registerTab) ------------------------------
  return {
    mount(panel) {
      build(panel);
    },
    unmount() {
      stopPackets();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      dom = null;
    },
    onShow() {
      shown = true;
      // Whatever happened while hidden is already in the counts; nothing travels for it.
      lastTab = null;
      const active = getActive();
      if (typeof active === 'string' && active) sub.dispatch({ channel: 'tab:active', payload: { sessionId: active } });
      seedLabels();
      renderSoon();
    },
    onHide() {
      shown = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      stopPackets();
    },
    onLang() {
      renderSoon();
    },
  };
}
