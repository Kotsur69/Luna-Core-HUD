'use strict';

// Usage-limit pauses of a God Mode run (orchestra.js), one per backend.
//
// plan.pauses = { all?: Pause, claude?: Pause, agy?: Pause, free?: Pause }
// with Pause = { until, startedAt } (epoch ms). 'all' is the whole-run pause
// and holds every package; a backend key holds only that backend's packages,
// so a limit on one backend never pauses the others, and each backend
// resumes at its own reset.
//
// plan.pausedUntil / plan.pauseStartedAt stay as the run-level summary that
// other modules, the board and the phone read: pausedUntil = when something
// resumes next (the whole-run pause's end while one is open), null when
// nothing is paused; pauseStartedAt = when the current continuous paused
// span began. plan.pausedTotalMs counts the union of those spans.
//
// Pure functions: nothing here mutates its input.

const ALL = 'all';
const BACKENDS = Object.freeze(['claude', 'agy', 'free']);
const KEYS = Object.freeze([ALL, ...BACKENDS]);

const isTime = (v) => Number.isFinite(v) && v > 0;

/** The pause key for a scope: a known backend, anything else the whole run. */
function keyOf(scope) {
  return BACKENDS.includes(scope) ? scope : ALL;
}

/**
 * Validated pauses (an unknown key or a broken entry is dropped).
 * @param {unknown} raw
 * @returns {Record<string, {until:number, startedAt:number}>}
 */
function normalizePauses(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of KEYS) {
    const e = raw[key];
    if (e && typeof e === 'object' && isTime(e.until) && isTime(e.startedAt)) out[key] = { until: e.until, startedAt: e.startedAt };
  }
  return out;
}

/** The plan's open pauses (none on a plan without the field). */
function pausesOf(plan) {
  return normalizePauses(plan && plan.pauses);
}

const hasPauses = (pauses) => Object.keys(pauses).length > 0;

/**
 * Keys of the open pauses that hold this package.
 * @param {object} pauses
 * @param {object} pkg
 * @param {(pkg:object, backend:string) => boolean} runsOn whether pkg runs on that backend
 */
function holdingKeys(pauses, pkg, runsOn) {
  return KEYS.filter((key) => pauses[key] && (key === ALL || runsOn(pkg, key)));
}

/** When the package's current paused span began (earliest holding pause), or null. */
function heldSince(pauses, pkg, runsOn) {
  const starts = holdingKeys(pauses, pkg, runsOn).map((key) => pauses[key].startedAt);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * Opens a pause, or extends the open one of the same key to a later reset.
 * A reset no later than the open one changes nothing.
 * @returns {{pauses:object, changed:boolean}}
 */
function withPause(pauses, key, until, nowMs) {
  const open = pauses[key];
  if (!isTime(until) || (open && open.until >= until)) return { pauses, changed: false };
  return { pauses: { ...pauses, [key]: { until, startedAt: open ? open.startedAt : nowMs } }, changed: true };
}

/** The pauses without `key`. */
function withoutPause(pauses, key) {
  const { [key]: _gone, ...rest } = pauses;
  return rest;
}

/**
 * The run-level fields after the open pauses become `next`: the summary
 * (pausedUntil / pauseStartedAt) and pausedTotalMs, which grows when the
 * last open pause ends.
 * @param {{pauseStartedAt?:number|null, pausedTotalMs?:number}} run
 * @param {object} next normalized pauses
 * @param {number} nowMs
 */
function withRunPauses(run, next, nowMs) {
  const open = hasPauses(next);
  const spanStart = isTime(run.pauseStartedAt) ? run.pauseStartedAt : null;
  const total = Number.isFinite(run.pausedTotalMs) ? run.pausedTotalMs : 0;
  const untils = Object.values(next).map((p) => p.until);
  return {
    pauses: next,
    pausedUntil: !open ? null : next[ALL] ? next[ALL].until : Math.min(...untils),
    pauseStartedAt: !open ? null : spanStart || nowMs,
    pausedTotalMs: !open && spanStart ? total + Math.max(0, nowMs - spanStart) : total,
  };
}

/** The latest reset among the open pauses, or null. */
function latestUntil(pauses) {
  const untils = Object.values(normalizePauses(pauses)).map((p) => p.until);
  return untils.length ? Math.max(...untils) : null;
}

/**
 * The pause time a package gets back when `ended` closes at nowMs: the part
 * after the package started and before any other pause still holding it
 * began (that one credits its own span when it ends), so overlapping pauses
 * are never counted twice.
 * @param {{startedAt:number}} ended
 * @param {number[]} stillHeldStarts startedAt of the pauses that still hold the package
 * @param {number|null|undefined} pkgStartedAt
 * @param {number} nowMs
 */
function resumeCredit(ended, stillHeldStarts, pkgStartedAt, nowMs) {
  const from = Math.max(ended.startedAt, isTime(pkgStartedAt) ? pkgStartedAt : nowMs);
  const to = Math.min(nowMs, ...stillHeldStarts);
  return Math.max(0, to - from);
}

module.exports = {
  ALL,
  BACKENDS,
  KEYS,
  keyOf,
  normalizePauses,
  pausesOf,
  hasPauses,
  holdingKeys,
  heldSince,
  withPause,
  withoutPause,
  withRunPauses,
  latestUntil,
  resumeCredit,
};
