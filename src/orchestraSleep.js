// ============================================================================
// LunaCore - God Mode: time the PC spent asleep is not worker time
// ----------------------------------------------------------------------------
// A worker's 120 min cap (orchestraSupervisor.js timedOut) counts wall-clock
// time minus pausedMs. A PC that slept three hours would wake every worker
// over its cap. This module finds the sleeps; orchestra.js credits them to
// the active packages' pausedMs, the way a usage-limit pause is credited.
//
// A sleep is seen two ways:
//   1. powerMonitor 'suspend' ... 'resume'  - the exact span
//   2. the watchdog tick arriving much later than its interval - Windows
//      does not always deliver 'suspend' (lid close, battery critical).
//      At most one interval of that gap can have been awake time, so the
//      credit is the gap minus one interval.
// Whichever of 'resume' and the first tick after the wake comes first
// closes the sleep; the other then finds nothing to credit.
//
// Pure decisions + one tiny piece of state; no timers.
// ============================================================================

'use strict';

// The God Mode watchdog interval (main.js ORCHESTRA_TICK_MS).
const WATCHDOG_TICK_MS = 60 * 1000;
// A tick this many intervals late means the machine slept.
const GAP_FACTOR = 3;
// Sleeps recorded per run (plan.sleeps), newest kept.
const MAX_SLEEP_LOG = 100;

/**
 * @param {{now:() => number, tickMs?:number|null}} deps tickMs: the watchdog
 *   interval; without it only 'suspend' / 'resume' pairs are seen (no gap
 *   check - a test driving tick() by hand jumps the clock on purpose).
 */
function createSleepWatch({ now, tickMs = null }) {
  const gapCheck = Number.isFinite(tickMs) && tickMs > 0;
  let suspendedAt = null;
  let lastTickAt = null;

  /** The sleep a tick / resume at `t` reveals by the tick gap alone. */
  function gapSleep(t) {
    if (!gapCheck || lastTickAt === null) return null;
    const late = t - lastTickAt;
    if (late <= tickMs * GAP_FACTOR) return null;
    return { start: lastTickAt + tickMs, durationMs: late - tickMs, source: 'gap' };
  }

  const fromSuspend = (t) => ({ start: suspendedAt, durationMs: Math.max(0, t - suspendedAt), source: 'suspend' });
  const real = (s) => (s && s.durationMs > 0 ? s : null);

  /** powerMonitor 'suspend'. */
  function onSuspend() {
    suspendedAt = now();
  }

  /**
   * powerMonitor 'resume'.
   * @returns {null|{start:number, durationMs:number, source:string}}
   */
  function onResume() {
    const t = now();
    const sleep = suspendedAt !== null ? fromSuspend(t) : gapSleep(t);
    suspendedAt = null;
    lastTickAt = t;
    return real(sleep);
  }

  /**
   * The watchdog tick; call it BEFORE any timeout check.
   * @returns {null|{start:number, durationMs:number, source:string}}
   */
  function onTick() {
    const t = now();
    const gap = gapSleep(t);
    let sleep = null;
    if (suspendedAt === null) sleep = gap;
    else if (gap) {
      // Woke up, 'resume' not delivered yet: the suspend gives the exact start.
      sleep = fromSuspend(t);
      suspendedAt = null;
    } else if (gapCheck && t - suspendedAt > tickMs * GAP_FACTOR) {
      // Ticks went on as usual long after a 'suspend': the PC never slept.
      suspendedAt = null;
    }
    lastTickAt = t;
    return real(sleep);
  }

  return { onSuspend, onResume, onTick, isSuspended: () => suspendedAt !== null };
}

/**
 * How much of `sleep` a package gets back on its pausedMs. Never time
 * before it started, never the part a usage-limit pause covers (that pause
 * is credited by orchestra.js resume()), never more than it has been
 * running net of earlier credits.
 * @param {{start:number, durationMs:number}} sleep
 * @param {{startedAt:number|null, pausedMs?:number}} pkg
 * @param {{now:number, pauseStartedAt?:number|null}} ctx pauseStartedAt: the
 *   run's usage-limit pause still open, if any
 * @returns {number} ms, >= 0
 */
function sleepCredit(sleep, pkg, { now, pauseStartedAt = null }) {
  if (!sleep || !Number.isFinite(pkg.startedAt)) return 0;
  const from = Math.max(sleep.start, pkg.startedAt);
  let to = sleep.start + sleep.durationMs;
  if (Number.isFinite(pauseStartedAt)) to = Math.min(to, pauseStartedAt);
  const net = now - pkg.startedAt - (pkg.pausedMs || 0);
  return Math.max(0, Math.min(to - from, net));
}

/**
 * The run's sleep log with `sleep` added: [{start, durationMs}], capped.
 * @param {unknown} log
 * @param {{start:number, durationMs:number}} sleep
 */
function recordSleep(log, sleep) {
  const list = normalizeSleeps(log);
  return [...list, { start: sleep.start, durationMs: sleep.durationMs }].slice(-MAX_SLEEP_LOG);
}

/** A stored sleep log, validated. */
function normalizeSleeps(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.durationMs) && s.durationMs > 0)
    .map((s) => ({ start: s.start, durationMs: s.durationMs }))
    .slice(-MAX_SLEEP_LOG);
}

/** Count and total time, for the run report. */
function sleepSummary(log) {
  const list = normalizeSleeps(log);
  return { count: list.length, totalMs: list.reduce((sum, s) => sum + s.durationMs, 0) };
}

module.exports = {
  createSleepWatch,
  sleepCredit,
  recordSleep,
  normalizeSleeps,
  sleepSummary,
  WATCHDOG_TICK_MS,
  GAP_FACTOR,
  MAX_SLEEP_LOG,
};
