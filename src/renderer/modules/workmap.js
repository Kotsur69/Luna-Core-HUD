// ============================================================================
// LunaCore - Live map (Ctrl+Shift+G): the Sessions tab, the work map
// ----------------------------------------------------------------------------
// What a session is doing, drawn on top of the pure model in workmapmodel.js
// (docs/untouched_docs/rag-stylememory.md, "Bonus"): the model in the centre
// with its context ring, a station per kind of tool call on a circle around
// it (name + count), failed calls in red, and a Memory station drawn as a
// hexagon so it reads apart from the rest. Slice 2 of #agymap made it move
// with the session:
//
//  - Bursts, ripples and afterglow (workmapFx.js): several packets out and
//    back for concurrent calls from a capped pool of reused dots, a ripple
//    when calls reach a station (a call that starts and ends in one frame
//    still shows), and a glow that follows each station's recent call rate.
//  - Satellites (workmapSatellites.js): the files, subagents, MCP servers,
//    processes and ports the session touched sprout from their station and
//    fade when stale. A file satellite opens its diff (#filediff-modal,
//    activefiles.js); any other satellite or a station opens the inspector.
//  - Session switcher, live ticker, inspector (workmapPanel.js).
//
//  - One subscription per app (createSessionsTab runs once, from liveMap.js),
//    on the push feeds sessions.js already listens to; no tokens. The map
//    only paints while its tab shows. The one poll it causes - the process
//    snapshot (src/sessionProcs.js) - is taken on show and given back on hide.
//  - The SVG is built once; a repaint writes attributes and text in place,
//    batched to one animation frame however many events arrived. While a
//    station glows or a satellite fades, a slow timer asks for more frames.
//  - Nothing travels, ripples or sprouts when motion is not allowed
//    (prefers-reduced-motion and the in-app motion axis): busy stations are
//    highlighted and satellites stand still instead.
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
import { truncate } from './liveMapHelpers.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { STATIONS, MEMORY_CALLS, subscribe, tabStateOf, createTabState, cleanText, contextFraction } from './workmapmodel.js';
import { svgNode, createPacketPool, playBurst, stopRipple, stepHeat, glowLevel } from './workmapFx.js';
import { createSatelliteLayer, selectSatellites, satelliteItemsFor, procListOf, snapshotSessionIds, mergeProcs } from './workmapSatellites.js';
import { createWorkmapPanel, resolveViewed, tickerRows, stationView, satelliteView } from './workmapPanel.js';
import { openDiffModal, closeDiffModal } from './activefiles.js';
import { shareModel, notifyModel } from './workmapFeed.js';

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
// How far a station's afterglow reaches past its disc.
const GLOW_PAD = 16;
// Repaint pace while something decays on its own: a glow, a fading satellite.
const GLOW_TICK_MS = 250;
const SATELLITE_TICK_MS = 2000;
const SWITCH_LABEL_CHARS = 40;
const round2 = (n) => Math.round(n * 100) / 100;

// Moved to the pure model (the Live Web reads it too); still offered from here.
export { contextFraction };

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
  const g = svgNode('g', 'wm-core', { role: 'img' });
  const disc = svgNode('circle', 'wm-core__disc', { cx: CENTER.x, cy: CENTER.y, r: CORE_R });
  const track = svgNode('circle', 'wm-ring__track', { cx: CENTER.x, cy: CENTER.y, r: RING_R });
  const fill = svgNode('circle', 'wm-ring__fill', { cx: CENTER.x, cy: CENTER.y, r: RING_R, transform: `rotate(-90 ${CENTER.x} ${CENTER.y})` });
  const model = svgNode('text', 'wm-core__model', { x: CENTER.x, y: CENTER.y - 14 });
  const pct = svgNode('text', 'wm-core__pct', { x: CENTER.x, y: CENTER.y + 14 });
  const sub = svgNode('text', 'wm-core__sub', { x: CENTER.x, y: CENTER.y + 34 });
  g.append(track, fill, disc, model, pct, sub);
  return { g, fill, model, pct, sub };
}

function buildStation(pos) {
  const memory = pos.id === 'memory';
  // A button: Enter / Space or a click opens the inspector (createSessionsTab's pickStation).
  const g = svgNode('g', `wm-station is-${pos.id}`, { role: 'button', tabindex: 0, 'data-station': pos.id });
  const title = svgNode('title');
  // The afterglow sits behind everything; the ripple spreads out from under the disc.
  const glow = svgNode('circle', 'wm-station__glow', { cx: pos.x, cy: pos.y, r: STATION_R + GLOW_PAD });
  const ripple = svgNode('circle', 'wm-ripple', { cx: pos.x, cy: pos.y, r: STATION_R });
  const halo = svgNode('circle', 'wm-station__halo', { cx: pos.x, cy: pos.y, r: STATION_R + 7 });
  const disc = memory
    ? svgNode('polygon', 'wm-station__disc', { points: hexPoints(pos.x, pos.y, STATION_R + 3) })
    : svgNode('circle', 'wm-station__disc', { cx: pos.x, cy: pos.y, r: STATION_R });
  const count = svgNode('text', 'wm-station__count', { x: pos.x, y: pos.y + 6 });
  const ys = stationLabelY(pos);
  const name = svgNode('text', 'wm-station__name', { x: pos.x, y: ys.name });
  const status = svgNode('text', 'wm-station__status', { x: pos.x, y: ys.status });
  g.append(title, glow, ripple, halo, disc, count, name, status);
  const parts = { g, title, glow, ripple, rippleAnim: null, disc, count, name, status, card: null, cardLabel: null, extras: [] };
  if (memory) {
    // The "card loaded" mark: filled = loaded, hollow = not loaded, hidden = unknown.
    const card = svgNode('rect', 'wm-card', { x: pos.x + STATION_R - 4, y: pos.y - STATION_R - 6, width: 12, height: 12, rx: 2, transform: `rotate(45 ${pos.x + STATION_R + 2} ${pos.y - STATION_R})` });
    // Said in words too, never by the mark's fill alone.
    const cardLabel = svgNode('text', 'wm-card__label', { x: pos.x + STATION_R + CARD_LABEL_DX, y: pos.y - STATION_R + CARD_LABEL_DY });
    g.append(card, cardLabel);
    parts.card = card;
    parts.cardLabel = cardLabel;
  }
  return parts;
}

function buildMap(onPickSatellite) {
  const root = svgNode('svg', 'wm-map', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, preserveAspectRatio: 'xMidYMid meet', role: 'group' });
  const spokes = svgNode('g', 'wm-spokes');
  const packetLayer = svgNode('g', 'wm-packets', { 'aria-hidden': 'true' });
  const satLayer = svgNode('g', 'wm-sats');
  const stationLayer = svgNode('g', 'wm-stations');
  const core = buildCore();
  const items = new Map();
  const positions = stationLayout(STATIONS);
  for (const pos of positions) {
    const seg = spokeOf(CENTER, pos, RING_R + SPOKE_GAP_CORE, STATION_R + SPOKE_GAP_STATION);
    const spoke = svgNode('line', 'wm-spoke', seg);
    spokes.append(spoke);
    const station = buildStation(pos);
    stationLayer.append(station.g);
    items.set(pos.id, { ...station, spoke, seg });
  }
  const pool = createPacketPool(packetLayer);
  const sats = createSatelliteLayer(satLayer, positions, { center: CENTER, view: VIEW, stationR: STATION_R, stations: positions, labelY: stationLabelY }, onPickSatellite);
  root.append(spokes, packetLayer, satLayer, core.g, stationLayer);
  return { root, core, items, pool, sats };
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

const clockNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * The Sessions tab. Subscribes at once, so the counts start with the app.
 * @param {{bridge?: object, getActiveSessionId?: () => (string|null)}} deps
 *   bridge: window.lunacore (onTools/onMcp/onContext/onTurnEnd/onSessions/onRestarted,
 *   getSessions, subscribeSessionProcs)
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
  // The switcher's choice: '' follows the active tab, a session id pins the map to it.
  let pinned = '';
  // Afterglow heat per station of the session shown, and when it last decayed.
  const heat = new Map();
  let heatAt = 0;
  let fxTimer = 0;
  let fxPace = 0;
  // OS processes under each tab (src/sessionProcs.js), only while the tab shows.
  let unsubProcs = null;
  const procs = new Map();

  const renderSoon = () => {
    if (shown && dom && !frame) frame = requestAnimationFrame(render);
  };
  // App-lifetime subscriptions, taken once here and never per show: the
  // bridge's onTools / onMcp / onContext / onTurnEnd / onSessions /
  // onRestarted (preload.js) return no unsubscribe. While the tab is hidden
  // they only fold events into the model - no DOM work, frame or timer.
  // liveMap.js never remounts a tab, so unmount() leaves them in place.
  // The process snapshot is the exception: it costs a process list per
  // poll in main, so it is taken on show and given back on hide.
  const sub = subscribe(
    bridge,
    (state) => {
      renderSoon();
      notifyModel(state);
    },
    { getActiveSessionId: getActive },
  );
  // The Live Web reads this subscription's state too (workmapFeed.js).
  shareModel(sub);

  if (typeof bridge.onSessions === 'function') {
    bridge.onSessions((payload) => {
      const list = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
      // The pushed list is the source of truth: a closed tab's name goes with it.
      labels.clear();
      rememberLabels(list);
      applyCardFlags(list);
      const live = new Set(list.map((m) => m && m.id).filter(Boolean));
      for (const id of sub.getState().tabs.keys()) if (!live.has(id)) sub.dispatch({ channel: 'tab:closed', payload: { sessionId: id } });
      // A pinned tab that closed: back to following the active one.
      if (pinned && !live.has(pinned)) pinned = '';
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
    if (sessionId === viewedId()) renderSoon();
  });

  function rememberLabels(list) {
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const label = [m.folder, m.profileLabel, m.id].find((v) => typeof v === 'string' && v);
      // A folder name is user text: one line, no bidi tricks in the switcher.
      labels.set(m.id, cleanText(label) || m.id);
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

  /** The session on the map: the pinned one while it is open, else the active tab. */
  function viewedId() {
    return resolveViewed(pinned, sub.getState().activeTab, labels);
  }

  // --- process snapshot (shown only) ------------------------------------------

  function onProcSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || !payload.sessions || typeof payload.sessions !== 'object') return;
    // Never later than now: a time in the future would keep an exited process from ever fading.
    const at = Number.isFinite(payload.at) ? Math.min(payload.at, Date.now()) : Date.now();
    const listed = new Set(snapshotSessionIds(payload));
    for (const id of new Set([...listed, ...procs.keys()])) {
      // A tab neither listed nor open is forgotten; one only missing from this snapshot fades out.
      if (!listed.has(id) && !labels.has(id)) procs.delete(id);
      else procs.set(id, mergeProcs(procs.get(id) || null, listed.has(id) ? procListOf(payload, id) : [], at));
    }
    renderSoon();
  }

  function startProcs() {
    if (unsubProcs || typeof bridge.subscribeSessionProcs !== 'function') return;
    const unsub = bridge.subscribeSessionProcs(onProcSnapshot);
    unsubProcs = typeof unsub === 'function' ? unsub : null;
  }

  function stopProcs() {
    const unsub = unsubProcs;
    unsubProcs = null;
    // What was alive is unknown from here on; the next show starts from a fresh snapshot.
    procs.clear();
    if (unsub) unsub();
  }

  // --- picking -----------------------------------------------------------------

  function onPickSatellite(stationId, item) {
    if (!dom) return;
    if (item.kind === 'file') {
      openDiffModal(item.key, viewedId()).catch((err) => console.error('[livemap] sessions map: opening the diff failed:', err));
      return;
    }
    dom.panel.inspect({ type: 'satellite', station: stationId, key: item.key }, document.activeElement);
    renderSoon();
  }

  const pickStation = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target && typeof e.target.closest === 'function' ? e.target.closest('.wm-station') : null;
    const id = g ? g.getAttribute('data-station') : null;
    if (!dom || !STATIONS.includes(id)) return;
    e.preventDefault();
    dom.panel.inspect({ type: 'station', station: id }, g);
    renderSoon();
  };

  function build(host) {
    const panel = createWorkmapPanel({
      onSelect: (value) => {
        pinned = typeof value === 'string' && labels.has(value) ? value : '';
        renderSoon();
      },
    });
    const head = el('div', 'wm-head');
    const summary = el('span', 'wm-head__sum');
    const turns = el('span', 'wm-head__turns');
    head.append(panel.switcher, summary, turns);
    const body = el('div', 'wm-body');
    const stage = el('div', 'lm-stage wm-stage');
    const map = buildMap(onPickSatellite);
    const message = el('div', 'lm-stage__msg');
    message.setAttribute('role', 'status');
    stage.append(map.root, message);
    body.append(stage, panel.side);
    const gap = el('p', 'wm-gap');
    host.classList.add('wm-panel');
    host.replaceChildren(head, body, gap);
    map.root.addEventListener('click', pickStation);
    map.root.addEventListener('keydown', pickStation);
    dom = { head, summary, turns, message, gap, panel, ...map };
  }

  // --- painting ------------------------------------------------------------------

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

  function paintStation(id, item, st, info, calls) {
    const name = t(`lm.wm.station.${id}`);
    const extras = item.card ? memoryExtras(item, calls, info) : { parts: [], cardText: '' };
    // The inspector lists the same extras.
    item.extras = extras.cardText ? [...extras.parts, extras.cardText] : extras.parts;
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
    setAttr(item.g, 'aria-label', [aria, ...extras.parts, extras.cardText, t('lm.wm.inspectHint')].filter(Boolean).join(', '));
    const lastError = st.lastError && st.lastError.message ? t('lm.wm.lastError', { msg: truncate(st.lastError.message, ERROR_TITLE_CHARS) }) : '';
    setText(item.title, [name, extras.cardText, lastError].filter(Boolean).join('\n'));
  }

  /** Stations, their afterglow, and (motion allowed) their bursts. True while any station still glows. */
  function paintStations(tab, info, deltas, travel) {
    const now = clockNow();
    const dt = heatAt ? now - heatAt : 0;
    heatAt = now;
    let warm = false;
    for (const id of STATIONS) {
      const item = dom.items.get(id);
      paintStation(id, item, tab.stations[id], info, tab.memoryCalls);
      const h = stepHeat(heat.get(id) || 0, dt, deltas[id].started);
      heat.set(id, h);
      warm = warm || h > 0;
      const glow = String(glowLevel(h));
      if (item.glow.style.opacity !== glow) item.glow.style.opacity = glow;
      if (travel) playBurst(dom.pool, item, id, deltas[id]);
    }
    return warm;
  }

  /** Every station's satellites. True while any is shown (they fade with time). */
  function paintSatellites(id, tab, now, travel) {
    const seen = id ? procs.get(id) || null : null;
    let any = false;
    for (const station of STATIONS) {
      const list = selectSatellites(satelliteItemsFor(station, tab.items, seen), now);
      dom.sats.paint(station, list, travel);
      any = any || list.length > 0;
    }
    return any;
  }

  function switcherOptions(activeId) {
    const activeName = activeId ? labels.get(activeId) || activeId : '';
    const follow = { value: '', label: activeName ? t('lm.wm.followActive', { name: truncate(activeName, SWITCH_LABEL_CHARS) }) : t('lm.wm.followNone') };
    return [follow, ...[...labels].map(([value, label]) => ({ value, label: truncate(label, SWITCH_LABEL_CHARS) }))];
  }

  /** The switcher, the ticker and, when open, the inspector. */
  function paintSide(id, tab, activeId, now) {
    const { panel } = dom;
    panel.paintSwitcher(switcherOptions(activeId), pinned);
    panel.paintTicker(tickerRows(tab.recent));
    const target = panel.target();
    if (!target) return;
    if (target.type === 'station') {
      const item = dom.items.get(target.station);
      panel.paintInspector(stationView(t(`lm.wm.station.${target.station}`), tab.stations[target.station], item.extras, tab.recent, target.station, dom.sats.shown(target.station)));
      return;
    }
    const seen = id ? procs.get(id) || null : null;
    const found = satelliteItemsFor(target.station, tab.items, seen).find((it) => it.key === target.key) || null;
    panel.paintInspector(satelliteView(found, now));
  }

  function paintHead(id, tab) {
    const totals = STATIONS.reduce(
      (acc, s) => ({ calls: acc.calls + tab.stations[s].total, running: acc.running + tab.stations[s].inFlight, failed: acc.failed + tab.stations[s].errors }),
      { calls: 0, running: 0, failed: 0 },
    );
    setText(dom.summary, id ? t('lm.wm.summary', totals) : '');
    setText(dom.turns, id && tab.turns ? t('lm.wm.turns', { n: tab.turns }) : '');
  }

  /** Repaints again soon while something decays on its own: a glow fast, a fading satellite slowly. */
  function scheduleFx(warm, satellites) {
    if (!shown || (!warm && !satellites)) return;
    const pace = warm ? GLOW_TICK_MS : SATELLITE_TICK_MS;
    // A glow that just lit must not wait out the slow satellite tick already pending.
    if (fxTimer && pace >= fxPace) return;
    if (fxTimer) clearTimeout(fxTimer);
    fxPace = pace;
    fxTimer = setTimeout(() => {
      fxTimer = 0;
      renderSoon();
    }, pace);
  }

  function render() {
    frame = 0;
    if (!dom || !shown) return;
    sub.prune();
    const state = sub.getState();
    const id = viewedId();
    const data = tabStateOf(state, id);
    const tab = data || IDLE_TAB;
    const same = id !== null && id === lastId;
    const deltas = same ? callDeltas(lastTab, tab) : callDeltas(null, tab);
    // Another session on the map: its glow starts cold, like its packets, and
    // an inspector open on the last one closes (focus stays where it is).
    if (!same) heat.clear();
    if (!same && lastId !== null) dom.panel.close({ keepFocus: true });
    lastId = id;
    lastTab = tab;
    const travel = motionNow();
    const now = Date.now();
    paintHead(id, tab);
    paintCore(tab);
    const warm = paintStations(tab, id ? memoryStationInfo(id) : null, deltas, travel);
    const satellites = paintSatellites(id, tab, now, travel);
    paintSide(id, tab, state.activeTab, now);
    let msg = '';
    if (!id) msg = t('lm.wm.noTab');
    else if (!data) msg = t('lm.wm.waiting');
    setText(dom.message, msg);
    dom.message.hidden = !msg;
    setAttr(dom.root, 'aria-label', t('lm.wm.label'));
    setText(dom.gap, t('lm.wm.gap'));
    scheduleFx(warm, satellites);
  }

  /** Everything that moves stops: packets, ripples, sprouts, and the repaint tick. */
  function stopMotion() {
    if (fxTimer) clearTimeout(fxTimer);
    fxTimer = 0;
    fxPace = 0;
    if (!dom) return;
    dom.pool.cancelAll();
    dom.sats.stop();
    for (const item of dom.items.values()) stopRipple(item);
  }

  // --- the tab contract (liveMap.js registerTab) ------------------------------
  return {
    mount(panel) {
      build(panel);
    },
    unmount() {
      stopMotion();
      stopProcs();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      dom = null;
    },
    onShow() {
      shown = true;
      // Whatever happened while hidden is already in the counts; nothing travels or glows for it.
      lastTab = null;
      heat.clear();
      heatAt = 0;
      const active = getActive();
      if (typeof active === 'string' && active) sub.dispatch({ channel: 'tab:active', payload: { sessionId: active } });
      startProcs();
      seedLabels();
      renderSoon();
    },
    onHide() {
      shown = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      stopMotion();
      stopProcs();
    },
    /** Esc closes what this tab opened on top first: the file diff, then the inspector. */
    onKey(e) {
      if (!e || e.key !== 'Escape') return false;
      if (closeDiffModal()) return true;
      return dom ? dom.panel.close() : false;
    },
    onLang() {
      renderSoon();
    },
  };
}
