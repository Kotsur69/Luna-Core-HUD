// ============================================================================
// LunaCore - God Mode board: why Retry was refused, and "Abort finish" (pure)
// ----------------------------------------------------------------------------
// orchestra:retry answers {ok:false, error} with a short code. The board
// shows it next to the package's own row, as a sentence that says what is in
// the way - never the bare code. A 'busy' while the run is finishing (merge +
// tests, src/orchestraFinalize.js) names the time it started; once that
// finish has run past main's threshold (view integration.abortAfter) the
// board offers "Abort finish". No DOM, no imports: node --test reads it.
// ============================================================================

'use strict';

// Refusal codes of orchestra:retry with their own message (orch.retryRefused.<code>).
export const RETRY_REFUSALS = Object.freeze(['busy', 'paused', 'notRetryable', 'noTab', 'briefFailed', 'batteryLow']);

const integrationOf = (plan) => (plan && plan.integration && typeof plan.integration === 'object' ? plan.integration : {});

/**
 * The i18n key of a refused Retry and the time it names, if any.
 * @param {unknown} code the error orchestra:retry returned
 * @param {object|null} plan the board's plan view
 * @returns {{key:string, at:number|null}}
 */
export function retryRefusal(code, plan) {
  const integ = integrationOf(plan);
  if (code === 'busy' && integ.running === true && Number.isFinite(integ.startedAt)) {
    return { key: 'orch.retryRefused.busyFinishing', at: integ.startedAt };
  }
  return { key: `orch.retryRefused.${RETRY_REFUSALS.includes(code) ? code : 'failed'}`, at: null };
}

/**
 * Whether a refusal still describes the board: once what was in the way is
 * gone (the finish ended, the pause lifted, the PC was plugged in) the stale
 * message goes, and Retry can simply be pressed again.
 * A 'busy' from another board action (planning, launching) has nothing to
 * wait out on the board, so it stays until the next Retry.
 * @param {unknown} code
 * @param {object|null} plan
 * @param {boolean} [whileFinishing] the refusal came while the run was finishing
 * @returns {boolean}
 */
export function refusalStillValid(code, plan, whileFinishing = true) {
  if (!plan) return false;
  if (code === 'busy') return whileFinishing ? integrationOf(plan).running === true : true;
  if (code === 'paused') return Number.isFinite(plan.pausedUntil);
  if (code === 'batteryLow') return !!(plan.battery && plan.battery.held === true);
  return true;
}

/**
 * Whether the board offers "Abort finish": the finish still runs and main's
 * threshold (integration.abortAfter, ABORT_FINISH_AFTER_MS) has passed.
 * @param {object|null} plan
 * @param {number} now epoch ms
 * @returns {boolean}
 */
export function canAbortFinish(plan, now) {
  const integ = integrationOf(plan);
  return integ.running === true && Number.isFinite(integ.abortAfter) && Number.isFinite(now) && now >= integ.abortAfter;
}
