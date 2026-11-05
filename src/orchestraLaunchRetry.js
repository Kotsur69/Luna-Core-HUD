// ============================================================================
// LunaCore - God Mode launch retries that wait out a flaky git
// ----------------------------------------------------------------------------
// A launch that fails on machinery is retried by orchestra.js's ladder:
// AUTO_RETRY_DELAY_MS apart, at most MAX_AUTO_RETRIES times, and the same
// error + detail twice means terminal. That rule is right for a git that
// REFUSED (a taken branch never frees itself) and wrong for a git that did
// not answer: right after a PC wake `git rev-parse` can time out a few times
// in a row with the very same detail, and three packages of a real run went
// terminal that way. Such a failure carries `retryable: true` (src/
// worktrees.js addWorktree) and gets its own ladder here - exponential
// backoff, never terminal on a repeat, at most MAX_TRANSIENT_RETRIES.
//
// The resume gate makes launches wait RESUME_SETTLE_MS after a system
// resume before touching git at all: disk, AV and network are still waking.
// ============================================================================

'use strict';

const TRANSIENT_BASE_MS = 30 * 1000;
const TRANSIENT_MAX_MS = 8 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;
const RESUME_SETTLE_MS = 20 * 1000;

/**
 * A launch failure that may clear up by itself: git hung, did not start, or
 * hit a lock while making the worktree.
 * @param {{error?:string, retryable?:boolean}} result
 */
function isTransientLaunchFailure(result) {
  return !!result && result.error === 'gitFailed' && result.retryable === true;
}

/** Backoff before transient retry number `n` (0-based): 30 s, 1, 2, 4, 8 min. */
function transientDelayMs(n) {
  const k = Number.isInteger(n) && n > 0 ? n : 0;
  return Math.min(TRANSIENT_BASE_MS * 2 ** k, TRANSIENT_MAX_MS);
}

/**
 * What to do with a failed launch.
 * @param {{before:{autoRetries?:number, error?:string|null, detail?:string|null},
 *   result:{error?:string, detail?:string|null, retryable?:boolean},
 *   transientTries:number, maxRetries:number, delayMs:number}} args
 * @returns {{action:'retry', transient:boolean, delayMs:number} | {action:'terminal', transient:boolean}}
 */
function launchRetryDecision({ before, result, transientTries, maxRetries, delayMs }) {
  if (isTransientLaunchFailure(result)) {
    const n = Number.isInteger(transientTries) && transientTries > 0 ? transientTries : 0;
    if (n >= MAX_TRANSIENT_RETRIES) return { action: 'terminal', transient: true };
    return { action: 'retry', transient: true, delayMs: transientDelayMs(n) };
  }
  const tries = before.autoRetries || 0;
  const repeated =
    tries > 0 && before.error === (result.error || null) && (before.detail || null) === (result.detail || null);
  if (repeated || tries >= maxRetries) return { action: 'terminal', transient: false };
  return { action: 'retry', transient: false, delayMs };
}

/**
 * Remembers the last system resume and says how long a launch should still
 * wait.
 * @param {{now:() => number, settleMs?:number}} deps
 */
function createResumeGate({ now, settleMs = RESUME_SETTLE_MS }) {
  let resumedAt = null;
  return {
    onResume() {
      resumedAt = now();
    },
    /** @returns {number} ms left to wait (never more than settleMs), 0 when launches may go */
    waitMs() {
      if (resumedAt == null) return 0;
      return Math.min(settleMs, Math.max(0, resumedAt + settleMs - now()));
    },
  };
}

module.exports = {
  isTransientLaunchFailure,
  transientDelayMs,
  launchRetryDecision,
  createResumeGate,
  MAX_TRANSIENT_RETRIES,
  RESUME_SETTLE_MS,
  TRANSIENT_BASE_MS,
};
