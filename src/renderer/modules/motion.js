// ============================================================================
// LunaCore - shared motion primitives (v0.10 phase 3)
// ----------------------------------------------------------------------------
// Three things every animated surface in the HUD needs and none of them owns:
// how long a token says something should take, how to cross-dissolve a change
// that rewrites the whole screen at once, and how to let an overlay leave.
//
// The single rule this file exists to enforce: NO DURATION IS EVER HARDCODED
// HERE. Every one is read from the live computed style, which is what makes the
// motion axis (v0.10 phase 2) and prefers-reduced-motion free - the token layer
// already zeroes --dur-* in both cases, so a resolved 0 arrives here as "do not
// animate, just land the state". Same doctrine panels.js's fold already uses.
//
// Nothing touches `document` at module scope and every impure entry point takes
// its host as a parameter, so node --test can require() this and hand it a stub
// (see test/motion.test.js) - the shape panels.js and modifiers.js established.
// ============================================================================

'use strict';

/** Exit motion runs at this fraction of the matching enter. MD motion: an exit
 *  that takes as long as its enter reads as the UI arguing with you. */
export const EXIT_RATIO = 0.65;

/** Class an overlay wears while it is leaving. Paired with styles.css. */
export const LEAVING_CLASS = 'is-leaving';

/**
 * A CSS <time> as milliseconds. `250ms` -> 250, `0.25s` -> 250, junk -> 0.
 * Bare numbers are treated as ms so a malformed token degrades to "instant"
 * rather than to "six minutes".
 */
export function parseDuration(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (s.endsWith('ms')) return n;
  if (s.endsWith('s')) return n * 1000;
  return n;
}

/**
 * Resolves a duration token against an element's computed style.
 *
 * Wrapped in try/catch rather than guarded: this is called from animation entry
 * points, and a HUD that throws on the way into a transition is worse than one
 * that skips it. A caught failure returns 0, which every caller reads as "skip".
 */
export function tokenMs(name, el) {
  try {
    const target = el || document.documentElement;
    return parseDuration(getComputedStyle(target).getPropertyValue(name));
  } catch {
    return 0;
  }
}

/** Same, for an easing token. Falls back to a curve rather than to `linear`,
 *  which is the one easing that always reads as machinery. */
export function tokenEase(name, el, fallback = 'cubic-bezier(0.22, 1, 0.36, 1)') {
  try {
    const target = el || document.documentElement;
    const v = getComputedStyle(target).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

// ---- Crossfade (3.1) --------------------------------------------------------

// The transition currently in flight, so a second one can skip it rather than
// let Chromium abort the pair with a console warning.
let running = null;

/**
 * Applies a change that rewrites the whole HUD, as a cross-dissolve.
 *
 * Switching theme slams ~45 tokens in one frame; switching density moves every
 * gap and font size at once. Both are correct and both look like a glitch. The
 * View Transitions API turns them into one dissolve for free - Electron 43 is
 * Chromium 13x, so it is simply there, it needs no library, and it adds nothing
 * for the CSP to block. The old instant swap stays as the fallback path.
 *
 * Skipped entirely when --dur-normal resolves to 0. That is not an optimisation:
 * with motion off, capturing and compositing two snapshots of the whole viewport
 * to then show one of them instantly is pure cost, and "off" should be off.
 *
 * @param {Function} apply the mutation - runs exactly once either way
 * @param {{doc?: Document, durationMs?: number}} [opts]
 * @returns {boolean} whether the change was animated
 */
export function crossfade(apply, opts = {}) {
  if (typeof apply !== 'function') return false;
  const doc = opts.doc || (typeof document === 'undefined' ? null : document);
  const ms =
    typeof opts.durationMs === 'number'
      ? opts.durationMs
      : tokenMs('--dur-normal', doc && doc.documentElement);

  if (!doc || typeof doc.startViewTransition !== 'function' || !(ms > 0)) {
    apply();
    return false;
  }

  // A rapid second switch: land the first one now. Without this the API logs
  // an abort and the two dissolves fight over the same snapshot pair.
  if (running && typeof running.skipTransition === 'function') running.skipTransition();

  const vt = doc.startViewTransition(apply);
  running = vt;
  if (vt && vt.finished && typeof vt.finished.then === 'function') {
    const clear = () => {
      if (running === vt) running = null;
    };
    vt.finished.then(clear, clear);
  }
  return true;
}

// ---- Overlay exit (3.2) -----------------------------------------------------

// element -> the timer that will finish its exit. A WeakMap because these
// entries have exactly the lifetime of the element they are keyed by.
const leaving = new WeakMap();

/**
 * Cancels an exit in flight and puts the element back in its resting state.
 *
 * MUST be called on every open path. Esc-then-reopen inside the exit window is
 * not a rare gesture on a keyboard-driven HUD, and without this the pending
 * timer would hide an overlay the user had just deliberately reopened.
 */
export function cancelExit(el, className = LEAVING_CLASS) {
  if (!el) return;
  const timer = leaving.get(el);
  if (timer) {
    clearTimeout(timer);
    leaving.delete(el);
  }
  el.classList.remove(className);
}

/**
 * Hides an overlay after letting it animate out.
 *
 * ENTER IS DELIBERATELY NOT TOUCHED. Every one of these opens from a keystroke
 * and several open dozens of times an hour; Emil's frequency rule says do not
 * animate that at all, and the 180ms `palette-in` already shipped is at the edge
 * of defensible. Exit is the half that was missing - the overlays currently just
 * cease to exist, which is the single most abrupt frame in the app.
 *
 * Driven by a timer rather than `animationend`: the exit is an animation on a
 * CHILD of the element being hidden, the event would have to be caught by
 * bubbling, and a listener that never fires (a display change mid-flight, a
 * layout rebuild) leaves an overlay stuck visible forever. A timer cannot.
 *
 * @param {Element} el the overlay root, the one carrying `hidden`
 * @param {{done?: Function, durationMs?: number, className?: string}} [opts]
 * @returns {boolean} whether it animated (false = hidden immediately)
 */
export function closeWithExit(el, opts = {}) {
  if (!el || el.hidden) return false;
  const className = opts.className || LEAVING_CLASS;

  const finish = () => {
    leaving.delete(el);
    el.classList.remove(className);
    el.hidden = true;
    if (typeof opts.done === 'function') opts.done();
  };

  // A second close while one is in flight (Esc on top of a backdrop click):
  // land the first rather than stacking timers on the same element.
  const pending = leaving.get(el);
  if (pending) {
    clearTimeout(pending);
    leaving.delete(el);
  }

  const ms =
    typeof opts.durationMs === 'number'
      ? opts.durationMs
      : Math.round(tokenMs('--dur-fast', el) * EXIT_RATIO);

  if (!(ms > 0)) {
    finish();
    return false;
  }

  el.classList.add(className);
  // The margin absorbs the frame the class change costs before the animation is
  // actually running. Landing early would cut the last frames off.
  leaving.set(el, setTimeout(finish, ms + 40));
  return true;
}
