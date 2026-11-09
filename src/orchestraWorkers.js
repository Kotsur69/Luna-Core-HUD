// ============================================================================
// LunaCore - God Mode "Workers" choice (FREE_GODMODE_V2_PLAN.md Slice F6)
// ----------------------------------------------------------------------------
// One selector on the board replaces the old "Free providers" tick:
//
//   claude  Claude only (default)            - today's run, unchanged
//   hybrid  Plan with free models in mind    - Claude plans; the planner may
//                                              mark simple packages "free"
//   free    Free only                        - today's "Free providers" run
//
// Pure rules only; src/orchestra.js wires them. Older stored plans and prefs
// only know the boolean tick (plan.freeMode / a free-planned plan), which
// migrates to 'free'.
// ============================================================================

'use strict';

const WORKERS = Object.freeze(['claude', 'hybrid', 'free']);
const DEFAULT_WORKERS = 'claude';
// Until free workers run hybrid packages, a "free" package runs on Claude
// Sonnet: an upgrade, never a downgrade (Mati's rule).
const FREE_PACKAGE_CLAUDE_MODEL = 'sonnet';

/** One of WORKERS, else null. */
function normalizeWorkers(value) {
  return WORKERS.includes(value) ? value : null;
}

/** One of WORKERS, else the default (Claude only). */
function workersOf(value) {
  return normalizeWorkers(value) || DEFAULT_WORKERS;
}

/**
 * The workers a planning request gets. A free planner always makes a
 * free-only run (D1); hybrid and Claude-only plan with Claude.
 * @param {unknown} requested
 * @param {'claude'|'free'} planner
 */
function planWorkers(requested, planner) {
  return planner === 'free' ? 'free' : workersOf(requested);
}

/**
 * The workers of a stored plan. Plans saved before the selector carry only
 * the old tick (freeMode) or a free planner: both mean "Free only".
 * @param {{workers?:unknown, freeMode?:unknown, buildPlanner?:unknown}|null} raw
 */
function storedWorkers(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_WORKERS;
  const set = normalizeWorkers(raw.workers);
  if (set) return set;
  return raw.freeMode === true || raw.buildPlanner === 'free' ? 'free' : DEFAULT_WORKERS;
}

/**
 * The workers a run starts with at Approve. The request may name `workers`
 * or (older renderer, phone) only the old `free` tick; nothing named keeps
 * the plan's own choice. "Plan with free models in mind" only means
 * something for a plan the planner made that way - on any other plan it is
 * a Claude-only run. A free-planned plan is always free-only (D1).
 * @param {{workers?:string, buildPlanner?:string}} plan
 * @param {{workers?:unknown, free?:unknown}} request
 */
function approveWorkers(plan, request) {
  if (plan.buildPlanner === 'free') return 'free';
  const asked = normalizeWorkers(request && request.workers) || (request && request.free === true ? 'free' : null);
  const current = workersOf(plan.workers);
  if (!asked) return current;
  if (asked === 'hybrid' && current !== 'hybrid') return DEFAULT_WORKERS;
  return asked;
}

/**
 * The Claude model a package's planner pick maps to. "free" exists only in
 * hybrid plans; it runs on Sonnet until free workers take hybrid packages.
 * @param {string|null} model
 */
function claudeModelOf(model) {
  return model === 'free' ? FREE_PACKAGE_CLAUDE_MODEL : model;
}

/**
 * The ui pref's value; a prefs file from before the selector may hold the
 * old boolean tick (orchestraFree), which migrates to 'free' / 'claude'.
 * @param {{orchestraWorkers?:unknown, orchestraFree?:unknown}|null} prefs
 */
function workersPrefOf(prefs) {
  if (!prefs || typeof prefs !== 'object') return DEFAULT_WORKERS;
  const set = normalizeWorkers(prefs.orchestraWorkers);
  if (set) return set;
  return prefs.orchestraFree === true ? 'free' : DEFAULT_WORKERS;
}

module.exports = {
  WORKERS,
  DEFAULT_WORKERS,
  FREE_PACKAGE_CLAUDE_MODEL,
  normalizeWorkers,
  workersOf,
  planWorkers,
  storedWorkers,
  approveWorkers,
  claudeModelOf,
  workersPrefOf,
};
