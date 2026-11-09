// ============================================================================
// LunaCore - God Mode: a 'noNodeModules' hold resumes on its own
// ----------------------------------------------------------------------------
// A run held for a broken node_modules (orchestra.js holdRun) used to wait
// for Mati to press Resume, even after node_modules was fixed (by hand, by a
// late install, by the temp-folder route). While the hold lasts, this watch
// checks the held folders again every HOLD_RECHECK_MS and calls Resume the
// moment they all pass. One timer at most; it is dropped on kill, discard
// and resume. Timer functions and the interval are injected (fake timers).
// ============================================================================

'use strict';

const HOLD_RECHECK_MS = 60 * 1000;

/**
 * @param {{
 *   isHeld: () => boolean,          // still held for node_modules (not killed)
 *   dirs: () => string[],           // the folders the hold is about
 *   check: (dir:string) => {ok:boolean},
 *   busy?: (dir:string) => boolean, // an install for this folder is in flight
 *   resume: () => Promise<{ok:boolean, error?:string}>|{ok:boolean},
 *   onStill?: (res:object) => void, // a folder still fails: its latest result
 *   intervalMs?: number,
 *   setTimer?: Function, clearTimer?: Function, log?: Function,
 * }} deps
 */
function createHoldWatch(deps) {
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0 ? deps.intervalMs : HOLD_RECHECK_MS;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || (() => {});
  let timer = null;

  /** Starts the watch (no-op while it already runs). */
  function arm() {
    if (timer !== null) return;
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Stops the watch (kill, discard, resume). */
  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  const again = () => {
    if (deps.isHeld()) arm();
  };

  function tick() {
    timer = null;
    if (!deps.isHeld()) return;
    const dirs = deps.dirs();
    // An install still moving entries in: a half-filled folder could pass
    // the check, so this tick waits for it.
    if (deps.busy && dirs.some((dir) => deps.busy(dir))) {
      arm();
      return;
    }
    for (const dir of dirs) {
      const res = deps.check(dir);
      if (!res || !res.ok) {
        if (deps.onStill) deps.onStill(res || {});
        arm();
        return;
      }
    }
    log('[orchestra] node_modules fixed - resuming the held run on its own');
    let result;
    try {
      result = deps.resume();
    } catch (err) {
      log(`[orchestra] automatic resume failed: ${err instanceof Error ? err.message : String(err)}`);
      again();
      return;
    }
    // Refused (busy, paused) or held again: the next tick tries again.
    Promise.resolve(result).then((r) => {
      if (!r || !r.ok) again();
    }, again);
  }

  return { arm, cancel, armed: () => timer !== null };
}

module.exports = { createHoldWatch, HOLD_RECHECK_MS };
