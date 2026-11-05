// ============================================================================
// LunaCore - God Mode integration status (pure half of the board's
// "Integration (...)" line)
// ----------------------------------------------------------------------------
// The stored integration.state is the source of truth: 'done' / 'failed'
// always win over the finalizer's live `running` flag. That flag stays true
// through cleanup, post-merge steps and the report after the merge itself
// settled, so a view broadcast in that window used to keep the board on
// "running..." for good. No DOM, no imports: node --test reads it directly.
// ============================================================================

'use strict';

/**
 * @typedef {{
 *   kind: 'running'|'done'|'partial'|'failed',
 *   mode: string, base: string|null, sha: string|null,
 *   merged: number, total: number,
 *   error: string|null, detail: string|null, elapsedMs: number|null,
 * }} IntegrationStatus
 */

const SHORT_SHA = 7;

const shortSha = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, SHORT_SHA) : null);

/** Packages this run merged into the base branch, and the ones it tried to. */
function mergeCounts(plan, integ) {
  const packages = Array.isArray(plan.packages) ? plan.packages : [];
  const merged = packages.filter((p) => p && p.merged === true).length;
  const skipped = Array.isArray(integ.skipped) ? integ.skipped.length : 0;
  return { merged, total: merged + skipped };
}

/**
 * What the integration step is doing or did, derived from the stored state.
 * @param {{integration?:object, integrationMode?:string, baseBranch?:string, packages?:object[]}|null} plan
 * @param {number} now epoch ms, for the elapsed time of a running step
 * @returns {IntegrationStatus|null} null when integration never started
 */
export function integrationStatus(plan, now) {
  if (!plan || typeof plan !== 'object') return null;
  const integ = plan.integration && typeof plan.integration === 'object' ? plan.integration : {};
  const mode = plan.integrationMode || 'pr';
  const base = typeof plan.baseBranch === 'string' && plan.baseBranch ? plan.baseBranch : null;
  const { merged, total } = mergeCounts(plan, integ);
  const out = { kind: null, mode, base, sha: shortSha(integ.headSha), merged, total, error: null, detail: null, elapsedMs: null };
  const state = integ.state;
  if (state === 'done') {
    const partial = mode === 'merge' && (integ.partial === true || total > merged);
    return { ...out, kind: partial ? 'partial' : 'done' };
  }
  if (state === 'failed') {
    return { ...out, kind: 'failed', error: integ.error || 'failed', detail: integ.detail || null };
  }
  // Only a step whose stored state says so (or a pre-state build's flag) runs.
  if (state === 'running' || (integ.running === true && !state)) {
    const started = Number(integ.startedAt);
    const elapsedMs = Number.isFinite(started) && started > 0 && Number.isFinite(now) ? Math.max(0, now - started) : null;
    return { ...out, kind: 'running', elapsedMs };
  }
  return null;
}

/**
 * "4m 05s" / "12s" / "1h 02m" for an elapsed time.
 * @param {number} ms
 * @returns {string}
 */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
