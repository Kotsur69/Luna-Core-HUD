// ============================================================================
// LunaCore - Work map satellites: what each station's calls touched
// ----------------------------------------------------------------------------
// Small nodes that sprout from a station of the Sessions map (workmap.js),
// slice 2 of #agymap, one per recent distinct item:
//
//   Files    the files Read / Edit / Write touched      (model items, kind file)
//   Agents   the subagents started, by type or name     (model items, kind agent)
//   MCP      the MCP servers called                     (model items, kind mcp)
//   Network  network MCP servers, and the ports the tab's processes listen on
//   Shell    the processes running under the tab        (src/sessionProcs.js)
//
// At most MAX_SATELLITES_PER_STATION per station, most recent first. One not
// touched for SATELLITE_FADE_AFTER_MS fades, and after SATELLITE_STALE_MS it
// is gone. A process or port counts as fresh while the latest snapshot lists
// it; once a snapshot no longer does, it fades from then.
//
// Each station has a fixed set of slots on a ring around it, in the
// directions clear of its spoke and its labels, best first. A satellite keeps
// its slot while it is shown, so a new one sprouts without the others moving.
// The DOM is built once and reused; text goes in through textContent only.
// Sprouting is a Web Animation on the motion tokens, skipped when the view
// says motion is off (prefers-reduced-motion or the in-app motion axis).
// The top half is pure, for test/workmapsatellites.test.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { truncate } from './liveMapHelpers.js';
import { tokenMs, tokenEase } from './motion.js';
import { cleanText, MAX_DETAIL_CHARS } from './workmapactivity.js';
import { svgNode } from './workmapFx.js';

/** Satellites one station shows at most. */
export const MAX_SATELLITES_PER_STATION = 6;
/** A satellite untouched this long starts to fade... */
export const SATELLITE_FADE_AFTER_MS = 60 * 1000;
/** ...and is gone after this long. */
export const SATELLITE_STALE_MS = 5 * 60 * 1000;
/** The faintest a fading satellite gets before it goes. */
export const MIN_SATELLITE_OPACITY = 0.3;
/** Distance from a station's centre to its satellites, in map units. */
export const SATELLITE_DIST = 60;
export const SATELLITE_R = 6;
/** Processes and ports remembered per tab, the oldest exited ones dropped first. */
export const MAX_PROCS_REMEMBERED = 48;
/** Candidate slot directions are this far apart. */
const SLOT_STEP_DEG = 30;
/** Slots keep this far (in degrees) from the side a station's labels are on... */
const LABEL_CLEAR_DEG = 50;
/** ...and from its spoke. */
const SPOKE_CLEAR_DEG = 40;
/** Slots stay this far inside the map's edges. */
const VIEW_MARGIN = 8;
const LABEL_CHARS = 14;
const LABEL_GAP = 9;
/** Half the width a station's name / status line can take. */
const LABEL_HALF_WIDTH = 45;
const STEM_GAP = 3;
// Mirrors src/sessionProcs.js' bounds: a snapshot is trusted no further.
const MAX_SNAPSHOT_SESSIONS = 64;
const MAX_PROCS_PER_SESSION = 64;
const MAX_PORTS_PER_PROC = 16;
const MAX_PORT = 65535;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const round2 = (n) => Math.round(n * 100) / 100;

// ---- pure helpers (tested) -----------------------------------------------------

/** The last segment of a path ('C:\\a\\b.js' -> 'b.js'); the whole text when it has none. */
export function baseName(path) {
  const s = typeof path === 'string' ? path : '';
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/** '+12 -3', '+4', '-2', or '' when no line changed. */
export function formatLines(added, removed) {
  const a = Number.isSafeInteger(added) && added > 0 ? added : 0;
  const r = Number.isSafeInteger(removed) && removed > 0 ? removed : 0;
  return [a ? `+${a}` : '', r ? `-${r}` : ''].filter(Boolean).join(' ');
}

/**
 * Opacity of a satellite last touched `ageMs` ago: 1 while fresh, then fading
 * to MIN_SATELLITE_OPACITY, null once stale (gone). An unknown age (no
 * timestamp in the feed) counts as fresh, like a call pruneStale() cannot age.
 * @param {number} ageMs
 * @returns {number|null}
 */
export function satelliteOpacity(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs <= SATELLITE_FADE_AFTER_MS) return 1;
  if (ageMs >= SATELLITE_STALE_MS) return null;
  const f = (ageMs - SATELLITE_FADE_AFTER_MS) / (SATELLITE_STALE_MS - SATELLITE_FADE_AFTER_MS);
  return round2(1 - f * (1 - MIN_SATELLITE_OPACITY));
}

const recencyOf = (it) => (it.alive ? Infinity : Number.isFinite(it.lastAt) ? it.lastAt : -Infinity);

function bySatelliteRank(a, b) {
  const ra = recencyOf(a);
  const rb = recencyOf(b);
  if (ra !== rb) return rb > ra ? 1 : -1;
  const wa = a.weight || 0;
  const wb = b.weight || 0;
  if (wa !== wb) return wb - wa;
  const fa = Number.isFinite(a.firstAt) ? a.firstAt : -Infinity;
  const fb = Number.isFinite(b.firstAt) ? b.firstAt : -Infinity;
  if (fa !== fb) return fb > fa ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * The satellites a station shows: items not yet stale, most recent first
 * (a live process ahead of everything; then by weight - a process with ports
 * - and the newest), capped, each with its opacity.
 * @template {{key:string, lastAt:number|null, firstAt?:number|null, alive?:boolean, weight?:number}} T
 * @param {T[]} items
 * @param {number} now epoch ms
 * @param {number} [cap=MAX_SATELLITES_PER_STATION]
 * @returns {Array<T & {opacity:number}>}
 */
export function selectSatellites(items, now, cap = MAX_SATELLITES_PER_STATION) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.key !== 'string' || !it.key) continue;
    const opacity = satelliteOpacity(it.alive ? 0 : now - it.lastAt);
    if (opacity !== null) out.push({ ...it, opacity });
  }
  return out.sort(bySatelliteRank).slice(0, Math.max(0, Math.floor(cap) || 0));
}

/**
 * Keeps satellites where they were: a key still shown stays in its slot, a
 * new one takes the first free slot (slots are ordered best first).
 * @param {(string|null)[]} prev key per slot, last paint
 * @param {string[]} next keys to show, most important first
 * @param {number} slotCount
 * @returns {(string|null)[]} key per slot
 */
export function assignSlots(prev, next, slotCount) {
  const n = Math.max(0, Math.floor(slotCount) || 0);
  const slots = new Array(n).fill(null);
  // Distinct keys, the first n of them: a repeated key must not use up a slot.
  const want = new Set();
  for (const key of Array.isArray(next) ? next : []) {
    if (want.size >= n) break;
    if (typeof key === 'string' && key) want.add(key);
  }
  const placed = new Set();
  (Array.isArray(prev) ? prev : []).forEach((key, i) => {
    if (i < n && want.has(key) && !placed.has(key)) {
      slots[i] = key;
      placed.add(key);
    }
  });
  let free = 0;
  for (const key of want) {
    if (placed.has(key)) continue;
    while (free < n && slots[free] !== null) free += 1;
    if (free >= n) break;
    slots[free] = key;
    placed.add(key);
  }
  return slots;
}

/** Degrees between two directions, 0..180. */
function angleDist(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Whether a satellite at `spot` stays off every OTHER station's disc and its
 * two label lines. Needs geometry.stations (the station centres) and
 * geometry.labelY (workmap.js stationLabelY()); without them nothing is
 * excluded, which is what a ring of few stations needs.
 */
function clearOfNeighbours(spot, own, geometry) {
  const { stations, labelY, stationR } = geometry;
  if (!Array.isArray(stations) || typeof labelY !== 'function') return true;
  for (const other of stations) {
    if (other === own || (other.x === own.x && other.y === own.y)) continue;
    if (Math.hypot(spot.x - other.x, spot.y - other.y) < stationR + SATELLITE_R + 2) return false;
    const ys = labelY(other);
    // A station's label lines are about 90 units wide, 14 high at their baselines.
    if (Math.abs(spot.x - other.x) >= LABEL_HALF_WIDTH + SATELLITE_R) continue;
    for (const baseline of [ys.name, ys.status]) {
      if (spot.y + SATELLITE_R > baseline - 11 && spot.y - SATELLITE_R < baseline + 3) return false;
    }
  }
  return true;
}

/**
 * A station's satellite slots, best first: on a ring of SATELLITE_DIST around
 * it, in directions at least SPOKE_CLEAR_DEG from its spoke and
 * LABEL_CLEAR_DEG from its labels (above the disc in the map's upper half,
 * below otherwise - workmap.js stationLabelY()). The most open directions
 * come first. Each slot says which way its label reads.
 * @param {{x:number, y:number}} pos station centre
 * @param {{center:{x:number, y:number}, view:{w:number, h:number}}} geometry
 * @returns {Array<{x:number, y:number, angleDeg:number, anchor:'start'|'end'|'middle', lx:number, ly:number}>}
 */
export function satelliteSlots(pos, geometry) {
  const { center, view } = geometry;
  const labelDeg = pos.y < center.y - 1 ? -90 : 90;
  const spokeDeg = (Math.atan2(center.y - pos.y, center.x - pos.x) * 180) / Math.PI;
  const clampX = (x) => Math.min(view.w - VIEW_MARGIN, Math.max(VIEW_MARGIN, x));
  const clampY = (y) => Math.min(view.h - VIEW_MARGIN, Math.max(VIEW_MARGIN, y));
  const at = (a) => {
    const rad = (a * Math.PI) / 180;
    return { x: round2(clampX(pos.x + SATELLITE_DIST * Math.cos(rad))), y: round2(clampY(pos.y + SATELLITE_DIST * Math.sin(rad))) };
  };
  const candidates = [];
  for (let a = 0; a < 360; a += SLOT_STEP_DEG) {
    const fromLabel = angleDist(a, labelDeg);
    const fromSpoke = angleDist(a, spokeDeg);
    if (fromLabel < LABEL_CLEAR_DEG || fromSpoke < SPOKE_CLEAR_DEG) continue;
    // With many stations on the ring a neighbour's disc or labels can sit in reach.
    const spot = at(a);
    if (!clearOfNeighbours(spot, pos, geometry)) continue;
    candidates.push({ a, open: Math.min(fromLabel, fromSpoke) });
  }
  candidates.sort((p, q) => q.open - p.open || p.a - q.a);
  return candidates.slice(0, MAX_SATELLITES_PER_STATION).map(({ a }) => {
    const rad = (a * Math.PI) / 180;
    const { x, y } = at(a);
    const c = Math.cos(rad);
    if (c > 0.3) return { x, y, angleDeg: a, anchor: 'start', lx: x + LABEL_GAP, ly: y + 3 };
    if (c < -0.3) return { x, y, angleDeg: a, anchor: 'end', lx: x - LABEL_GAP, ly: y + 3 };
    return { x, y, angleDeg: a, anchor: 'middle', lx: x, ly: Math.sin(rad) < 0 ? y - LABEL_GAP - 2 : y + LABEL_GAP + 8 };
  });
}

/**
 * One tab's processes from a process snapshot (it crossed IPC: validated and
 * cleaned here; main already scrubbed command lines into `label`).
 * @param {unknown} snapshot {at, sessions: {[sessionId]: [{pid, name, label, ports}]}}
 * @param {string} sessionId
 * @returns {Array<{pid:number, name:string, label:string, ports:number[]}>}
 */
export function procListOf(snapshot, sessionId) {
  const sessions = snapshot && typeof snapshot === 'object' ? snapshot.sessions : null;
  if (!sessions || typeof sessions !== 'object' || typeof sessionId !== 'string') return [];
  if (!Object.prototype.hasOwnProperty.call(sessions, sessionId)) return [];
  const list = sessions[sessionId];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, MAX_PROCS_PER_SESSION)) {
    if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.pid) || p.pid <= 0) continue;
    const name = cleanText(p.name, LABEL_CHARS * 4) || String(p.pid);
    const label = cleanText(p.label, MAX_DETAIL_CHARS) || name;
    const raw = Array.isArray(p.ports) ? p.ports.slice(0, MAX_PORTS_PER_PROC) : [];
    const ports = [...new Set(raw.filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_PORT))];
    out.push({ pid: p.pid, name, label, ports });
  }
  return out;
}

/** The session ids a snapshot lists, validated and bounded. */
export function snapshotSessionIds(snapshot) {
  const sessions = snapshot && typeof snapshot === 'object' ? snapshot.sessions : null;
  if (!sessions || typeof sessions !== 'object') return [];
  return Object.keys(sessions).filter((id) => SESSION_ID_RE.test(id)).slice(0, MAX_SNAPSHOT_SESSIONS);
}

/**
 * Folds one snapshot into what was seen of a tab's processes and ports:
 * everything listed is alive as of `at`; anything no longer listed stays,
 * not alive, as last seen at `at`, so it fades out like a stale file.
 * Bounded by MAX_PROCS_REMEMBERED (the longest-gone go first).
 * @param {Map<string, object>|null} prev
 * @param {ReturnType<typeof procListOf>} list
 * @param {number} at the snapshot's time, epoch ms
 * @returns {Map<string, object>} a new map; `prev` is not changed
 */
export function mergeProcs(prev, list, at) {
  const next = new Map();
  const before = prev instanceof Map ? prev : new Map();
  const firstAt = (key) => (before.has(key) ? before.get(key).firstAt : at);
  for (const p of list) {
    const key = `pid:${p.pid}`;
    next.set(key, { key, kind: 'process', pid: p.pid, name: p.name, label: p.label, ports: p.ports, firstAt: firstAt(key), lastAt: at, alive: true, weight: p.ports.length ? 1 : 0 });
    for (const port of p.ports) {
      const pk = `port:${port}`;
      if (!next.has(pk)) next.set(pk, { key: pk, kind: 'port', port, pid: p.pid, name: p.name, label: `:${port}`, firstAt: firstAt(pk), lastAt: at, alive: true, weight: 0 });
    }
  }
  for (const [key, old] of before) {
    if (!next.has(key)) next.set(key, old.alive ? { ...old, alive: false, lastAt: at } : old);
  }
  if (next.size <= MAX_PROCS_REMEMBERED) return next;
  const gone = [...next.values()].filter((it) => !it.alive).sort((a, b) => a.lastAt - b.lastAt);
  for (const it of gone) {
    if (next.size <= MAX_PROCS_REMEMBERED) break;
    next.delete(it.key);
  }
  return next;
}

/**
 * Everything a station could show as satellites, before selection.
 * @param {string} stationId
 * @param {Record<string, object[]>|null} tabItems TabState.items
 * @param {Map<string, object>|null} procs mergeProcs() of the tab
 * @returns {object[]}
 */
export function satelliteItemsFor(stationId, tabItems, procs) {
  const own = tabItems && Array.isArray(tabItems[stationId]) ? tabItems[stationId] : [];
  const seen = procs instanceof Map ? [...procs.values()] : [];
  if (stationId === 'shell') return [...own, ...seen.filter((it) => it.kind === 'process')];
  if (stationId === 'network') return [...own, ...seen.filter((it) => it.kind === 'port')];
  return own;
}

// ---- describing a satellite ---------------------------------------------------------

/**
 * What a satellite says: its short label, its tooltip and its accessible name.
 * @param {object} item
 * @returns {{label:string, title:string, aria:string}}
 */
export function describeSatellite(item) {
  const kind = t(`lm.wm.sat.${item.kind}`);
  if (item.kind === 'process' || item.kind === 'port') {
    const short = item.kind === 'port' ? item.label : truncate(item.name, LABEL_CHARS);
    const state = t(item.alive ? 'lm.wm.sat.alive' : 'lm.wm.sat.gone');
    const ports = item.kind === 'process' && item.ports.length ? t('lm.wm.sat.ports', { list: item.ports.join(', ') }) : '';
    const what = item.kind === 'port' ? `${item.name} ${item.label}` : item.label;
    return { label: short, title: [`${kind}: ${what}`, ports, state].filter(Boolean).join('\n'), aria: `${kind}: ${what}, ${state}` };
  }
  const name = item.kind === 'file' ? baseName(item.label) : item.label;
  const counts = [t('lm.wm.sat.calls', { n: item.calls }), formatLines(item.added, item.removed), item.failed ? t('lm.wm.failed', { n: item.failed }) : '']
    .filter(Boolean)
    .join(' · ');
  const hint = item.kind === 'file' ? t('lm.wm.sat.openDiff') : t('lm.wm.inspectHint');
  return { label: truncate(name, LABEL_CHARS), title: [`${kind}: ${item.label}`, counts, hint].join('\n'), aria: `${kind}: ${name}, ${counts}. ${hint}` };
}

// ---- DOM --------------------------------------------------------------------------

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};
const setAttr = (node, key, value) => {
  const v = String(value);
  if (node.getAttribute(key) !== v) node.setAttribute(key, v);
};

function buildSatellite(layer, pos, slot, index, stationR) {
  const dx = slot.x - pos.x;
  const dy = slot.y - pos.y;
  const len = Math.hypot(dx, dy) || 1;
  const g = svgNode('g', 'wm-sat is-empty', { tabindex: 0, role: 'button', 'data-station': pos.id, 'data-slot': index });
  // Sprouting grows out of the station's centre.
  g.style.transformOrigin = `${pos.x}px ${pos.y}px`;
  const stem = svgNode('line', 'wm-sat__stem', {
    x1: round2(pos.x + (dx / len) * (stationR + STEM_GAP)),
    y1: round2(pos.y + (dy / len) * (stationR + STEM_GAP)),
    x2: round2(slot.x - (dx / len) * (SATELLITE_R + 1)),
    y2: round2(slot.y - (dy / len) * (SATELLITE_R + 1)),
  });
  const title = svgNode('title');
  const dot = svgNode('circle', 'wm-sat__dot', { cx: slot.x, cy: slot.y, r: SATELLITE_R });
  const label = svgNode('text', 'wm-sat__label', { x: slot.lx, y: slot.ly, 'text-anchor': slot.anchor });
  g.append(title, stem, dot, label);
  layer.append(g);
  return { g, title, label, anim: null };
}

function sprout(slot) {
  const ms = tokenMs('--dur-normal');
  if (!ms || typeof slot.g.animate !== 'function') return;
  if (slot.anim) slot.anim.cancel();
  slot.anim = slot.g.animate([{ transform: 'scale(0.15)', opacity: 0 }, { transform: 'scale(1)' }], { duration: ms, easing: tokenEase('--ease-smooth') });
}

/**
 * The satellites of every station: slots built once into `layer`, painted per frame.
 * @param {SVGGElement} layer
 * @param {Array<{id:string, x:number, y:number}>} positions stationLayout()
 * @param {{center:{x:number, y:number}, view:{w:number, h:number}, stationR:number}} geometry
 * @param {(stationId: string, item: object) => void} onPick a satellite was clicked or pressed
 * @returns {{paint: (stationId: string, list: object[], motion: boolean) => void, shown: (stationId: string) => object[], stop: () => void}}
 */
export function createSatelliteLayer(layer, positions, geometry, onPick) {
  const stations = new Map();
  for (const pos of positions) {
    const slots = satelliteSlots(pos, geometry).map((slot, i) => buildSatellite(layer, pos, slot, i, geometry.stationR));
    stations.set(pos.id, { slots, keys: slots.map(() => null), items: slots.map(() => null) });
  }

  const pick = (e) => {
    const g = e.target && typeof e.target.closest === 'function' ? e.target.closest('.wm-sat') : null;
    const st = g ? stations.get(g.getAttribute('data-station')) : null;
    const item = st ? st.items[Number(g.getAttribute('data-slot'))] : null;
    if (!item) return;
    e.preventDefault();
    onPick(g.getAttribute('data-station'), item);
  };
  layer.addEventListener('click', pick);
  layer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') pick(e);
  });

  function paint(stationId, list, motion) {
    const st = stations.get(stationId);
    if (!st) return;
    const byKey = new Map(list.map((it) => [it.key, it]));
    const keys = assignSlots(st.keys, list.map((it) => it.key), st.slots.length);
    keys.forEach((key, i) => {
      const slot = st.slots[i];
      const item = key ? byKey.get(key) || null : null;
      const fresh = item !== null && key !== st.keys[i];
      st.items[i] = item;
      if (!item) {
        setAttr(slot.g, 'class', 'wm-sat is-empty');
        return;
      }
      const d = describeSatellite(item);
      setText(slot.label, d.label);
      setText(slot.title, d.title);
      setAttr(slot.g, 'aria-label', d.aria);
      setAttr(slot.g, 'class', `wm-sat is-${item.kind}${item.failed > 0 ? ' has-errors' : ''}${item.alive === false ? ' is-gone' : ''}`);
      const opacity = String(item.opacity);
      if (slot.g.style.opacity !== opacity) slot.g.style.opacity = opacity;
      if (fresh && motion) sprout(slot);
    });
    st.keys = keys;
  }

  return {
    paint,
    /** What a station shows now, slot by slot (empty slots left out). */
    shown: (stationId) => (stations.get(stationId) ? stations.get(stationId).items.filter(Boolean) : []),
    stop() {
      for (const st of stations.values()) {
        for (const slot of st.slots) {
          if (slot.anim) slot.anim.cancel();
          slot.anim = null;
        }
      }
    },
  };
}
