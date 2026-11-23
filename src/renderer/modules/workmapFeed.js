// ============================================================================
// LunaCore - the work map model, shared read-only
// ----------------------------------------------------------------------------
// The app's one subscription to the metrics feeds is the Sessions tab's
// (workmap.js createSessionsTab): preload's metrics listeners cannot be
// removed, so a second view must not subscribe again. The God Mode Live Web
// (liveWebView.js, slice 3 of #agymap) reads every worker's tab state from
// here instead, and listens only while it shows.
// No DOM, no timer, no IPC.
// ============================================================================

'use strict';

let shared = null;
const listeners = new Set();

/**
 * Hands the Sessions tab's subscription over (workmapmodel.js subscribe()).
 * @param {{getState: () => object}|null} sub
 */
export function shareModel(sub) {
  shared = sub && typeof sub.getState === 'function' ? sub : null;
}

/** The work map model's state now (read-only by contract), or null before the Sessions tab exists. */
export const workmapModelState = () => (shared ? shared.getState() : null);

/**
 * Calls `fn(state)` after every model change until the returned function runs.
 * @param {(state: object) => void} fn
 * @returns {() => void}
 */
export function onWorkmapModel(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tells every listener about a model change; one that throws is logged and the rest still run. */
export function notifyModel(state) {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('[livemap] a work map model listener failed:', err);
    }
  }
}
