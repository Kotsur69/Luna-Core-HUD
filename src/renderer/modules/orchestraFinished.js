// ============================================================================
// LunaCore - God Mode "run finished" rules (pure half of the finished screen)
// ----------------------------------------------------------------------------
// isRunFinished(): a run is finished when it started, settled on its own (not
// killed, not cut by a shutdown), every package sits in a settled state,
// nothing runs, and the finalizer stored integration.state 'done' (a run with
// nothing to merge still ends 'done'). A failed integration is not finished:
// "Finish run" stays on the board so it can be tried again. A plan run waits
// for its "Approve plan" too.
// finishedSummary(): what the finished screen shows - package counts, merge
// result, the release the run cut and the wall-clock duration.
// Built only on fields main's view() already sends. No DOM, no imports:
// node --test reads it directly.
// ============================================================================

'use strict';

// Mirrors orchestraSupervisor's SETTLED_STATES / ACTIVE_STATES.
const SETTLED_STATES = new Set(['pushed', 'stalled', 'failed', 'closed', 'killed']);
const ACTIVE_STATES = new Set(['launched', 'finishing']);
const FAILED_STATES = new Set(['stalled', 'failed', 'killed']);
const SHORT_SHA = 7;

const isObj = (v) => !!v && typeof v === 'object';
const packagesOf = (plan) => (Array.isArray(plan.packages) ? plan.packages.filter(isObj) : []);
const integrationOf = (plan) => (isObj(plan.integration) ? plan.integration : {});
const epoch = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/**
 * Whether the board's run is over and only its summary is left to show.
 * @param {object|null} plan the board's run view (main's orchestra view())
 * @returns {boolean}
 */
export function isRunFinished(plan) {
  if (!isObj(plan) || plan.started !== true || plan.killed === true || plan.settled !== true) return false;
  // Cut by a shutdown, scheduled, or held for a machine problem: the board's own controls are needed.
  if (isObj(plan.interrupted) || plan.scheduledAt || isObj(plan.hold)) return false;
  const packages = packagesOf(plan);
  if (!packages.length) return false;
  if (packages.some((p) => ACTIVE_STATES.has(p.state) || !SETTLED_STATES.has(p.state))) return false;
  const integ = integrationOf(plan);
  if (integ.running === true || integ.state !== 'done') return false;
  // A plan run ends with "Approve plan" on its own panel; until then it is not done.
  if (isObj(plan.planRun) && !plan.planRun.approved) return false;
  return true;
}

/** The release the run's post-merge step cut, or null. */
function releaseOf(integ) {
  const release = isObj(integ.postMerge) && isObj(integ.postMerge.release) ? integ.postMerge.release : null;
  if (!release || release.released !== true) return null;
  const tag = typeof release.tag === 'string' && release.tag ? release.tag : release.version ? `v${release.version}` : null;
  if (!tag) return null;
  return { tag, url: typeof release.url === 'string' && release.url ? release.url : null };
}

/** Run start -> finish (finalize stamp), else the packages' own first start / last finish. */
function durationOf(plan, packages, integ) {
  const starts = packages.map((p) => epoch(p.startedAt)).filter((v) => v !== null);
  const ends = packages.map((p) => epoch(p.finishedAt)).filter((v) => v !== null);
  const start = epoch(plan.runStartedAt) || (starts.length ? Math.min(...starts) : null);
  const end = epoch(integ.at) || (ends.length ? Math.max(...ends) : null);
  return start !== null && end !== null && end >= start ? end - start : null;
}

/**
 * The finished screen's numbers.
 * @param {object} plan the board's run view
 * @returns {{
 *   total:number, done:number, failed:number, closed:number, skipped:number,
 *   merged:number, mode:string, base:string|null, sha:string|null,
 *   prs:Array<{id:string, url:string}>, release:{tag:string, url:string|null}|null,
 *   durationMs:number|null,
 * }}
 */
export function finishedSummary(plan) {
  const safe = isObj(plan) ? plan : {};
  const packages = packagesOf(safe);
  const integ = integrationOf(safe);
  const count = (pred) => packages.filter(pred).length;
  return {
    total: packages.length,
    done: count((p) => p.state === 'pushed'),
    failed: count((p) => FAILED_STATES.has(p.state)),
    closed: count((p) => p.state === 'closed'),
    // Pushed but left out of the merge (integration.skipped).
    skipped: Array.isArray(integ.skipped) ? integ.skipped.length : 0,
    merged: count((p) => p.merged === true),
    mode: typeof safe.integrationMode === 'string' && safe.integrationMode ? safe.integrationMode : 'pr',
    base: typeof safe.baseBranch === 'string' && safe.baseBranch ? safe.baseBranch : null,
    sha: typeof integ.headSha === 'string' && integ.headSha ? integ.headSha.slice(0, SHORT_SHA) : null,
    prs: packages.filter((p) => typeof p.prUrl === 'string' && p.prUrl).map((p) => ({ id: String(p.id), url: p.prUrl })),
    release: releaseOf(integ),
    durationMs: durationOf(safe, packages, integ),
  };
}
