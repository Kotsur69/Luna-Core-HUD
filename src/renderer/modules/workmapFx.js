// ============================================================================
// LunaCore - Work map effects: packet bursts, impact ripples, afterglow
// ----------------------------------------------------------------------------
// What makes the Sessions map (workmap.js) move with the session, slice 2 of
// #agymap. All of it is driven by the per-frame call deltas the map already
// computes; nothing here reads a feed, starts a timer or touches IPC.
//
//  - Bursts: every call that starts this frame sends a packet out along its
//    station's spoke, every call that ends sends one back (red when it
//    failed), staggered and side by side on lanes so concurrent calls read as
//    several. At most MAX_BURST_PER_STATION per station and direction a frame.
//  - The packets are a fixed pool of MAX_PACKETS reused SVG dots, one Web
//    Animation each. A full pool drops its oldest packet, never the new one.
//  - Ripple: a ring that spreads from a station when calls arrive, so a call
//    that starts and ends inside one frame (a fast Read, very common) still
//    shows - its packets may overlap, its ripple does not.
//  - Afterglow: each station has a heat that grows by one per call and halves
//    every GLOW_HALF_LIFE_MS; its glow is that heat squashed into 0..1, so a
//    busy station stays lit and a quiet one fades. The view decays it on its
//    own repaint ticks.
//
// Durations come from the motion tokens (motion.js): under prefers-reduced-
// motion and the in-app motion axis they resolve to 0 and nothing animates.
// The view also gates on travelAllowed() before calling playBurst().
// The top half is pure, for test/workmapfx.test.js.
// ============================================================================

'use strict';

import { tokenMs, tokenEase, EXIT_RATIO } from './motion.js';

/** Packets in the pool: concurrent calls past this drop the oldest packet in flight. */
export const MAX_PACKETS = 48;
/** Packets one station sends per direction in one frame; a burst of 100 reads shows as this many. */
export const MAX_BURST_PER_STATION = 6;
/** Delay between the packets of one burst. */
export const PACKET_STAGGER_MS = 55;
/** Sideways distance between packet lanes on one spoke, in map units. */
export const LANE_SPACING = 5;
/** A return that follows a start in the same frame leaves once the outbound packet has mostly arrived. */
export const BACK_DELAY_RATIO = 0.6;
/** The ripple lands as the outbound packet arrives (its fade-out starts at 0.8 of the way). */
const RIPPLE_ARRIVAL_RATIO = 0.8;
/** How far a ripple spreads, as a multiple of the station's radius. */
const RIPPLE_SCALE = 1.9;
/** Afterglow heat halves this often. */
export const GLOW_HALF_LIFE_MS = 4000;
/** Heat at which the glow reaches 1 - 1/e (about 0.63). */
export const GLOW_HEAT_SCALE = 4;
/** Below this heat a station is cold: no glow, no repaint tick for it. */
const GLOW_COLD_HEAT = 0.05;
const PACKET_R = 4;
// Lanes alternate around the spoke: centre, one side, the other, further out.
const LANE_PATTERN = Object.freeze([0, 1, -1, 2, -2]);

export const SVG_NS = 'http://www.w3.org/2000/svg';
const round2 = (n) => Math.round(n * 100) / 100;
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// ---- pure helpers (tested) -----------------------------------------------------

/**
 * How one station's calls of one frame show.
 * @param {{started?:number, ended?:number, failed?:number}|null} delta callDeltas() for the station
 * @param {number} [cap=MAX_BURST_PER_STATION]
 * @returns {{out:number, back:number, failedBack:number, ripple:boolean, failedRipple:boolean, backDelayed:boolean}}
 *   out / back packets; the first failedBack returns are red; backDelayed = the
 *   returns wait for this frame's outbound packets (calls that started and ended in one tick)
 */
export function burstPlan(delta, cap = MAX_BURST_PER_STATION) {
  const d = delta && typeof delta === 'object' ? delta : {};
  const started = count(d.started);
  const ended = count(d.ended);
  const failed = Math.min(count(d.failed), ended);
  const limit = count(cap);
  const out = Math.min(started, limit);
  const back = Math.min(ended, limit);
  return {
    out,
    back,
    failedBack: Math.min(failed, back),
    ripple: started + ended > 0,
    failedRipple: failed > 0,
    backDelayed: out > 0 && back > 0,
  };
}

/** Sideways offset of the i-th packet of a burst: 0, +1, -1, +2, -2 lanes, then round again. */
export function laneOffset(i) {
  const n = Number.isSafeInteger(i) && i >= 0 ? i : 0;
  return LANE_PATTERN[n % LANE_PATTERN.length] * LANE_SPACING;
}

/**
 * A spoke moved sideways (perpendicular to itself) by `offset` map units.
 * @param {{x1:number, y1:number, x2:number, y2:number}} seg
 * @param {number} offset
 */
export function laneSegment(seg, offset) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy);
  if (!len || !Number.isFinite(offset) || !offset) return { x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 };
  const nx = (-dy / len) * offset;
  const ny = (dx / len) * offset;
  return { x1: round2(seg.x1 + nx), y1: round2(seg.y1 + ny), x2: round2(seg.x2 + nx), y2: round2(seg.y2 + ny) };
}

/**
 * The pool slot a new packet takes: the first free one (its animation is
 * over), else the one started longest ago - the oldest packet is dropped,
 * never the new one.
 * @param {Array<{busyUntil:number, startedAt:number}>} slots
 * @param {number} now same clock as busyUntil / startedAt
 * @returns {number} slot index, -1 for an empty pool
 */
export function pickSlot(slots, now) {
  if (!Array.isArray(slots) || slots.length === 0) return -1;
  let oldest = 0;
  for (let i = 0; i < slots.length; i += 1) {
    if (!(slots[i].busyUntil > now)) return i;
    if (slots[i].startedAt < slots[oldest].startedAt) oldest = i;
  }
  return oldest;
}

/**
 * A station's heat after `dtMs` of decay and `calls` new calls (one heat each).
 * @param {number} heat
 * @param {number} dtMs time since the last step
 * @param {number} calls calls started since then
 * @param {number} [halfLifeMs=GLOW_HALF_LIFE_MS]
 * @returns {number} 0 once it is cold
 */
export function stepHeat(heat, dtMs, calls, halfLifeMs = GLOW_HALF_LIFE_MS) {
  const h = Number.isFinite(heat) && heat > 0 ? heat : 0;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const decayed = Number.isFinite(halfLifeMs) && halfLifeMs > 0 ? h * 0.5 ** (dt / halfLifeMs) : 0;
  const next = decayed + count(calls);
  return next < GLOW_COLD_HEAT ? 0 : next;
}

/**
 * The glow of a heat, 0..1: the first calls light a station quickly, a steady
 * stream saturates it. About 0.22 for one call, 0.63 for four, 0.92 for ten.
 * @param {number} heat
 * @returns {number} rounded to 2 decimals
 */
export function glowLevel(heat) {
  if (!Number.isFinite(heat) || heat < GLOW_COLD_HEAT) return 0;
  return round2(1 - Math.exp(-heat / GLOW_HEAT_SCALE));
}

// ---- DOM ------------------------------------------------------------------------

/** An SVG element with a class and attributes (values stringified). */
export function svgNode(tag, cls, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const clockNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * The packet pool: MAX_PACKETS dots built once into `layer` and reused.
 * @param {SVGGElement} layer
 * @param {number} [size=MAX_PACKETS]
 * @returns {{send: (seg: object, opts: {outward:boolean, failed:boolean, station:string, delayMs?:number, lane?:number}) => void,
 *   cancelAll: () => void, size: number}}
 */
export function createPacketPool(layer, size = MAX_PACKETS) {
  const slots = [];
  for (let i = 0; i < size; i += 1) {
    const node = svgNode('circle', 'wm-packet', { cx: 0, cy: 0, r: PACKET_R });
    layer.append(node);
    slots.push({ node, anim: null, busyUntil: 0, startedAt: 0 });
  }

  function send(seg, { outward, failed, station, delayMs = 0, lane = 0 }) {
    const ms = tokenMs('--dur-normal');
    if (!ms) return;
    const now = clockNow();
    const slot = slots[pickSlot(slots, now)];
    if (!slot || typeof slot.node.animate !== 'function') return;
    if (slot.anim) slot.anim.cancel();
    // The return reads as the call settling: shorter, like any exit.
    const duration = outward ? ms : Math.round(ms * EXIT_RATIO);
    const s = laneSegment(seg, laneOffset(lane));
    const [from, to] = outward ? [[s.x1, s.y1], [s.x2, s.y2]] : [[s.x2, s.y2], [s.x1, s.y1]];
    slot.node.setAttribute('class', `wm-packet is-${station}${failed ? ' is-failed' : ''}`);
    slot.startedAt = now;
    slot.busyUntil = now + delayMs + duration;
    slot.anim = slot.node.animate(
      [
        { transform: `translate(${from[0]}px, ${from[1]}px)`, opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.8 },
        { transform: `translate(${to[0]}px, ${to[1]}px)`, opacity: 0 },
      ],
      { duration, delay: delayMs, fill: 'backwards', easing: outward ? tokenEase('--ease-smooth') : tokenEase('--ease-sharp') },
    );
  }

  function cancelAll() {
    for (const slot of slots) {
      if (slot.anim) slot.anim.cancel();
      slot.anim = null;
      slot.busyUntil = 0;
    }
  }

  return { send, cancelAll, size };
}

/** A ring spreading from the station; a newer one replaces the one still running. */
function playRipple(item, failed, delayMs) {
  const ms = tokenMs('--dur-slow');
  const node = item.ripple;
  if (!ms || !node || typeof node.animate !== 'function') return;
  if (item.rippleAnim) item.rippleAnim.cancel();
  node.setAttribute('class', `wm-ripple${failed ? ' is-failed' : ''}`);
  item.rippleAnim = node.animate(
    [
      { transform: 'scale(1)', opacity: 0.7 },
      { transform: `scale(${RIPPLE_SCALE})`, opacity: 0 },
    ],
    { duration: ms, delay: delayMs, fill: 'backwards', easing: tokenEase('--ease-smooth') },
  );
}

/**
 * Plays one station's frame: its burst of packets and its ripple. Call only
 * when travel is allowed (workmap.js travelAllowed()).
 * @param {{send: Function}} pool createPacketPool()
 * @param {{seg: object, ripple: SVGElement, rippleAnim?: Animation|null}} item the station's view parts
 * @param {string} station
 * @param {{started:number, ended:number, failed:number}} delta
 */
export function playBurst(pool, item, station, delta) {
  const plan = burstPlan(delta);
  if (!plan.ripple) return;
  const ms = tokenMs('--dur-normal');
  for (let i = 0; i < plan.out; i += 1) {
    pool.send(item.seg, { outward: true, failed: false, station, delayMs: i * PACKET_STAGGER_MS, lane: i });
  }
  const backStart = plan.backDelayed ? Math.round(ms * BACK_DELAY_RATIO) : 0;
  for (let i = 0; i < plan.back; i += 1) {
    pool.send(item.seg, { outward: false, failed: i < plan.failedBack, station, delayMs: backStart + i * PACKET_STAGGER_MS, lane: i });
  }
  playRipple(item, plan.failedRipple, plan.out > 0 ? Math.round(ms * RIPPLE_ARRIVAL_RATIO) : 0);
}

/** Stops a station's ripple (the tab hides or unmounts). */
export function stopRipple(item) {
  if (item && item.rippleAnim) item.rippleAnim.cancel();
  if (item) item.rippleAnim = null;
}
