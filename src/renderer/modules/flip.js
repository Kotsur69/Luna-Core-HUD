// ============================================================================
// LunaCore - list row enter / exit / reorder (v0.10 phase 3.3)
// ----------------------------------------------------------------------------
// Every list in the HUD is drawn the same way: `list.innerHTML = ''`, then a
// fresh row per item. That is a good pattern - there is no diffing to get wrong
// and no stale node to leak - but it means the DOM has NO IDENTITY between two
// renders, so a row that merely moved is indistinguishable from a row that was
// destroyed and a different one created. Which is exactly why these lists pop:
// eight ports rescan, nothing about them changed, and all eight blink.
//
// So identity is what this file adds, and it adds it in the cheapest possible
// way: each row carries `data-flip-key`, and the caller brackets its existing
// render with two calls. Nothing about how a widget builds its rows changes.
//
//   const snap = beginListUpdate(els.list);
//   els.list.innerHTML = '';
//   ... build rows, each with li.dataset.flipKey = <stable id> ...
//   endListUpdate(els.list, snap);
//
// With keys the three cases separate themselves and each gets the motion it has
// actually earned:
//
//   survived, same place  -> nothing at all. This is the common case by far, and
//                            the whole reason a re-render every 5s stops flashing.
//   survived, moved       -> FLIP. Measured before, measured after, played back
//                            from the delta - the row never appears to jump.
//   new                   -> enter: opacity + a 6px rise + a 2px blur (the blur
//                            is what stops it reading as a slide), staggered,
//                            and CAPPED. A 40-row list animating 40 rows at 18ms
//                            each is 720ms of nonsense nobody asked to watch, so
//                            the first 12 stagger and the rest are simply there.
//   gone                  -> the old node is re-attached as an absolutely
//                            positioned ghost at its last measured rect and
//                            faded out, while its neighbours FLIP up into the
//                            space. Without the ghost the list would snap closed
//                            a frame before anything moved.
//
// Durations and easings are read from the live computed style, never hardcoded,
// so the motion axis and prefers-reduced-motion both resolve to 0 and this file
// skips every animation without a second branch. See modules/motion.js.
//
// planList() is pure and takes plain rect objects, so the interesting half is
// require()-able from node --test with no DOM at all (test/flip.test.js).
// ============================================================================

'use strict';

import { tokenMs, tokenEase, EXIT_RATIO } from './motion.js';

/** Rows past this many get no entrance. See the header - it is a cap on how
 *  long the whole reveal is allowed to take, not on how much is drawn. */
export const FLIP_ANIMATE_CAP = 12;

/** How far a new row rises into place, and how much it is blurred on the way. */
export const ENTER_TRAVEL_PX = 6;
export const ENTER_BLUR_PX = 2;

/** Row stagger as a fraction of --stagger. That token is tuned for REGIONS on a
 *  layout switch (45ms, a handful of them); rows come by the dozen and need a
 *  much tighter beat or the list reads as loading rather than arriving. */
export const ROW_STAGGER_RATIO = 0.4;

/** Marks a list this module manages - styles.css gives it `position: relative`
 *  so a ghost has something to be absolute against. Applied here rather than
 *  asked of six widgets, so no list can be wired up and quietly miss it. */
export const LIST_CLASS = 'flip-list';
/** A row on its way out: out of flow, out of the way of the pointer. */
export const GHOST_CLASS = 'flip-ghost';

/**
 * Works out what each key did between two renders.
 *
 * Pure, and the only part of this file worth testing directly: rects go in as
 * plain `{top, left}` objects, a plan comes out. `cap` bounds only the number of
 * STAGGERED entrances - every new key is still reported, the ones past the cap
 * simply carry `animate: false`.
 *
 * @param {Map<string, {top: number, left: number}>} prev
 * @param {Map<string, {top: number, left: number}>} next
 * @param {number} [cap]
 * @returns {{moves: Array, enters: Array, exits: string[]}}
 */
export function planList(prev, next, cap = FLIP_ANIMATE_CAP) {
  const moves = [];
  const enters = [];
  const exits = [];
  const before = prev instanceof Map ? prev : new Map();
  const after = next instanceof Map ? next : new Map();

  let entered = 0;
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) {
      enters.push({ key, index: entered, animate: entered < cap });
      entered += 1;
      continue;
    }
    // FLIP's invert step: where the row WAS, expressed from where it now is.
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (dx || dy) moves.push({ key, dx, dy });
  }

  for (const key of before.keys()) if (!after.has(key)) exits.push(key);

  return { moves, enters, exits };
}

/**
 * Measures every keyed row relative to the list's own CONTENT box rather than
 * to the viewport.
 *
 * This is the detail that makes the whole thing safe on a list that scrolls or
 * moves. Two renders of the session-timeline strip are separated by an
 * auto-scroll to the newest turn; two renders of a panel list can be separated
 * by the panel above it folding. In viewport coordinates both read as "every
 * row moved", and FLIP would faithfully animate a slide that never happened.
 * Measured against the list, only a row that actually changed place has moved -
 * and the ghosts fall out for free, since absolute offsets inside the list are
 * already the coordinate space this returns.
 */
function measureRows(listEl) {
  const host = listEl.getBoundingClientRect();
  const ox = host.left - listEl.scrollLeft;
  const oy = host.top - listEl.scrollTop;
  const rects = new Map();
  const nodes = new Map();
  for (const node of Array.from(listEl.children)) {
    const key = node.dataset && node.dataset.flipKey;
    // No key means the caller did not opt this row in - a static hint line, a
    // header. It is left out of the plan entirely rather than guessed at.
    if (!key || node.classList.contains(GHOST_CLASS)) continue;
    const r = node.getBoundingClientRect();
    rects.set(key, { top: r.top - oy, left: r.left - ox, width: r.width, height: r.height });
    nodes.set(key, node);
  }
  return { rects, nodes };
}

/**
 * Measures a list immediately before its rows are thrown away.
 *
 * Keeps the NODES as well as their rects - `innerHTML = ''` detaches them but
 * cannot collect them while this map holds a reference, which is what makes an
 * exit animation possible at all after a wholesale rebuild.
 *
 * Returns an inert snapshot (`ok: false`) for a list that is not on screen or
 * has no box: a folded panel measures every row at 0x0, and animating from that
 * would fling the whole list in from the top-left corner on unfold.
 *
 * @param {Element} listEl
 */
export function beginListUpdate(listEl) {
  const snap = { ok: false, rects: new Map(), nodes: new Map() };
  if (!listEl || !listEl.isConnected) return snap;

  const host = listEl.getBoundingClientRect();
  if (!host.width && !host.height) return snap;

  snap.ok = true;
  listEl.classList.add(LIST_CLASS);
  const measured = measureRows(listEl);
  snap.rects = measured.rects;
  snap.nodes = measured.nodes;
  return snap;
}

/**
 * Plays the motion the rebuild earned.
 *
 * Uses the Web Animations API rather than CSS classes for one reason: every
 * value here is computed per row per render (a delta nobody can write down, a
 * stagger that depends on position), and driving that through CSS would mean
 * writing a dozen custom properties per row every render. `el.animate()` also
 * cannot be left behind - there is no class to forget to remove.
 *
 * @param {Element} listEl
 * @param {object} snap from beginListUpdate()
 * @param {{cap?: number, enter?: boolean, axis?: 'x'|'y', durationMs?: number}} [opts]
 */
export function endListUpdate(listEl, snap, opts = {}) {
  if (!snap || !snap.ok || !listEl || !listEl.isConnected) return;

  const ms = typeof opts.durationMs === 'number' ? opts.durationMs : tokenMs('--dur-fast', listEl);
  if (!(ms > 0)) return; // motion off, or reduced to nothing. Nothing to do.

  const { rects: next, nodes } = measureRows(listEl);

  const cap = typeof opts.cap === 'number' ? opts.cap : FLIP_ANIMATE_CAP;
  const plan = planList(snap.rects, next, cap);
  const easeIn = tokenEase('--ease-smooth', listEl);
  const easeOut = tokenEase('--ease-sharp', listEl, 'cubic-bezier(0.4, 0, 0.2, 1)');
  const stagger = Math.round(tokenMs('--stagger', listEl) * ROW_STAGGER_RATIO);
  const horizontal = opts.axis === 'x';

  for (const move of plan.moves) {
    const node = nodes.get(move.key);
    if (!node) continue;
    node.animate([{ transform: `translate(${move.dx}px, ${move.dy}px)` }, { transform: 'none' }], {
      duration: ms,
      easing: easeIn,
    });
  }

  if (opts.enter !== false) {
    const from = horizontal
      ? `translateX(${ENTER_TRAVEL_PX}px)`
      : `translateY(${ENTER_TRAVEL_PX}px)`;
    for (const enter of plan.enters) {
      const node = nodes.get(enter.key);
      if (!node || !enter.animate) continue;
      node.animate(
        [
          { opacity: 0, transform: from, filter: `blur(${ENTER_BLUR_PX}px)` },
          { opacity: 1, transform: 'none', filter: 'blur(0px)' },
        ],
        // `backwards` matters: without it a staggered row sits at full opacity
        // until its delay elapses, so the whole list appears at once and THEN
        // re-animates, which is worse than no stagger at all.
        { duration: ms, delay: enter.index * stagger, easing: easeIn, fill: 'backwards' }
      );
    }
  }

  if (!plan.exits.length) return;
  // No arithmetic needed here: measureRows() already returned offsets inside
  // the list's content box, which is exactly what `position: absolute` against
  // .flip-list wants.
  const exitMs = Math.round(ms * EXIT_RATIO);
  for (const key of plan.exits) {
    const node = snap.nodes.get(key);
    const rect = snap.rects.get(key);
    if (!node || !rect) continue;
    node.classList.add(GHOST_CLASS);
    node.style.top = `${rect.top}px`;
    node.style.left = `${rect.left}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    listEl.appendChild(node);
    const anim = node.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: exitMs,
      easing: easeOut,
      fill: 'forwards',
    });
    const drop = () => node.remove();
    anim.finished.then(drop, drop);
  }
}
