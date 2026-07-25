// ============================================================================
// LunaCore - Skill Tracker tiles (B8: duration, not a blink)
// ----------------------------------------------------------------------------
// A tile lights for as long as the tool is ACTUALLY running, sweeping left to
// right while it does. The old version only knew that a tool had been seen, so
// it lit for a fixed 1500 ms: a two-minute Bash went dark while still working
// and an instant Read looked identical to it.
//
// What made the difference is upstream, in observer.js: the transcript pairs a
// `tool_use` id with the `tool_result` that closes it, so we now receive
// start/end events instead of a flat list of names. This module owns the visual
// state machine and nothing else.
//
// Four things it has to survive, none of them cosmetic:
//
//  1. The watcher polls every 1.5 s, so a fast tool starts AND ends inside one
//     tick and arrives as start+end together. MIN_ACTIVE_MS keeps it on screen
//     long enough to be seen - measured from when the tile lit, not from the
//     transcript timestamp, because we may have read the start seconds late.
//  2. A tool's runtime is unknowable in advance, so the fill is a LOOPING
//     sweep, not a percentage - a progress bar would need a total we do not
//     have.
//  3. A killed session leaves a `tool_use` with no result. MAX_ACTIVE_MS is the
//     watchdog that stops a tile glowing forever.
//  4. Several tools run at once and several names share one tile (Edit /
//     MultiEdit / NotebookEdit), so a tile tracks a SET of outstanding ids and
//     only goes dark when the last one closes.
//
// One reconcile loop drives all of it. Per-tile and per-id timers were the
// obvious alternative and would have meant four timer maps to keep in sync.
// ============================================================================

'use strict';

import { registerSessionView } from './bus.js';

/** Minimum time a tile stays lit once shown, so a sub-tick tool is visible. */
const MIN_ACTIVE_MS = 900;
/** Watchdog: a tool_use with no matching tool_result cannot glow past this. */
const MAX_ACTIVE_MS = 10 * 60 * 1000;
/** How long the "finished" flash lasts after the sweep stops. */
const DONE_MS = 450;
/** Legacy stdout detections carry no end signal - they expire on their own. */
const BLINK_MS = 1500;
/** Reconcile cadence. Only runs while something is lit. */
const TICK_MS = 120;

/** Live session: id -> { tile, startedAt, ttl }. `ttl` set only for blinks. */
let open = new Map();
/** Per-tile display state: tile -> { shownAt, settleAt, doneAt }. */
const display = new Map();

let loopTimer = null;
let blinkSeq = 0;

const tileEls = new Map();
for (const el of document.querySelectorAll('.skill-tile')) {
  tileEls.set(el.dataset.skill, el);
}

/** How many tools are in flight for each tile right now. */
function countsByTile() {
  const counts = new Map();
  for (const { tile } of open.values()) counts.set(tile, (counts.get(tile) || 0) + 1);
  return counts;
}

/**
 * Single pass: drop expired ids, then bring every tile's classes in line with
 * how many of its tools are still running.
 * @returns {boolean} true while anything still needs repainting
 */
function reconcile() {
  const now = Date.now();

  // Obstacle 3, and legacy blinks: nothing may outlive its deadline.
  for (const [id, rec] of open) {
    if (now - rec.startedAt > (rec.ttl || MAX_ACTIVE_MS)) open.delete(id);
  }

  const counts = countsByTile();
  let busy = false;

  for (const [name, el] of tileEls) {
    const running = counts.get(name) || 0;
    let d = display.get(name);

    if (running > 0) {
      if (!d) {
        d = { shownAt: now, settleAt: null, doneAt: null };
        display.set(name, d);
      }
      // A second tool on an already-lit tile must not restart the fade.
      d.settleAt = null;
      d.doneAt = null;
      el.classList.add('is-active', 'is-running');
      el.classList.remove('is-done');
      busy = true;
      continue;
    }

    if (!d) continue; // dark, nothing pending

    if (d.doneAt === null) {
      // Obstacle 1: honour the visibility floor before the sweep may stop.
      if (d.settleAt === null) d.settleAt = Math.max(now, d.shownAt + MIN_ACTIVE_MS);
      if (now < d.settleAt) {
        busy = true;
        continue;
      }
      d.doneAt = now;
      el.classList.remove('is-running');
      el.classList.add('is-done');
      busy = true;
      continue;
    }

    if (now - d.doneAt >= DONE_MS) {
      el.classList.remove('is-active', 'is-done');
      display.delete(name);
    } else {
      busy = true;
    }
  }

  return busy;
}

/** Runs the reconcile loop only while there is something to animate. */
function pump() {
  const busy = reconcile();
  if (busy && !loopTimer) {
    loopTimer = setInterval(() => {
      if (!reconcile()) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
    }, TICK_MS);
  }
}

function applyEventsTo(map, events) {
  for (const ev of events) {
    if (!ev || !ev.tile) continue;
    if (ev.phase === 'start') {
      map.set(ev.id, { tile: ev.tile, startedAt: ev.at || Date.now(), ttl: 0 });
    } else {
      map.delete(ev.id);
    }
  }
}

/**
 * Apply transcript lifecycle events to the tab you are looking at.
 * @param {{phase:'start'|'end', id:string, tile:string, at:number|null}[]} events
 */
export function applyToolEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  applyEventsTo(open, events);
  pump();
}

/**
 * The same fold for a tab running in the background: keep its set of open tools
 * accurate so switching to it shows what is running THERE, without touching the
 * DOM. No timers either - stale ids are pruned when the bucket is loaded.
 */
export function trackBucketTools(bucket, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  if (!bucket.toolsOpen) bucket.toolsOpen = new Map();
  applyEventsTo(bucket.toolsOpen, events);
}

/**
 * Legacy path: the stdout scan in main.js finds tool NAMES and has no idea when
 * they finish. Kept as a backstop for launches whose transcript we cannot pin.
 * Each detection becomes a self-expiring id, so it flows through the same state
 * machine - and if the transcript already has that tile genuinely running, the
 * extra id changes nothing.
 * @param {string[]} tiles
 */
export function lightTiles(tiles) {
  if (!Array.isArray(tiles) || tiles.length === 0) return;
  const now = Date.now();
  for (const tile of tiles) {
    if (!tileEls.has(tile)) continue;
    open.set(`blink:${tile}:${++blinkSeq}`, { tile, startedAt: now, ttl: BLINK_MS });
  }
  pump();
}

/** Session restarted: whatever was running belonged to the process that died. */
export function resetTiles() {
  open = new Map();
  pump();
}

registerSessionView({
  save(bucket) {
    bucket.toolsOpen = new Map(open);
  },
  load(bucket) {
    // A background tab ran no watchdog, so anything long past its deadline is
    // dropped here instead of lighting up the moment you switch to that tab.
    const now = Date.now();
    open = new Map();
    for (const [id, rec] of bucket.toolsOpen || []) {
      if (now - rec.startedAt <= MAX_ACTIVE_MS) open.set(id, rec);
    }
    // Repaint from scratch - the tiles still show the tab we just left.
    for (const el of tileEls.values()) el.classList.remove('is-active', 'is-running', 'is-done');
    display.clear();
    pump();
  },
  clear(bucket) {
    bucket.toolsOpen = new Map();
  },
});
