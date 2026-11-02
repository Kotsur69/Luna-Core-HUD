// ============================================================================
// LunaCore - God Mode finished-run IPC (main process)
// ----------------------------------------------------------------------------
// orchestra:resend-email {planId} -> {ok} | {ok:false, reason}
//   "Resend report email" on the finished run: the run's report email again
//   (godmodePending.resend), same report text and HTML attachment.
//
// The renderer is never trusted: a run id must be a plain lower-case id
// (RUN_ID_RE - no dots, no path separators) AND name a report main wrote
// (<runsDir>/<id>.md is a regular file). One resend at a time, and not more
// often than RESEND_GAP_MS. Lives outside main.js (past the file-size
// guideline); main.js wires it with one register() call.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const RESEND_GAP_MS = 15 * 1000;
// Resend failure reasons the board has words for; anything else is 'failed'.
const RESEND_REASONS = new Set([
  'badId', 'unknownRun', 'busy', 'rate-limited', 'gmail-not-connected', 'no-report', 'gmail-network',
  'gmail-timeout', 'gmail-auth', 'gmail-scope', 'gmail-no-client', 'gmail-failed',
]);

/**
 * A run id from the renderer, checked: a plain id string whose markdown
 * report exists in the runs folder.
 * @param {() => string|null} runsDir
 * @param {unknown} id
 * @returns {boolean}
 */
function isKnownRunId(runsDir, id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id) || path.basename(id) !== id) return false;
  const dir = runsDir();
  if (typeof dir !== 'string' || !dir) return false;
  const file = path.join(dir, `${id}.md`);
  // Belt and braces: the joined path must still sit directly in the runs folder.
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return false;
  try {
    // lstat: a link named <id>.md is not a report main wrote.
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {{handle: Function}} ipcMain
 * @param {{
 *   runsDir: () => string|null,
 *   resendRunEmail: (planId:string) => Promise<{ok:boolean, reason?:string}>,
 *   now?: () => number,
 * }} deps
 */
function register(ipcMain, deps) {
  const now = deps.now || Date.now;
  let resending = false;
  let lastResendAt = -Infinity;

  ipcMain.handle('orchestra:resend-email', async (_event, planId) => {
    if (!isKnownRunId(deps.runsDir, planId)) return { ok: false, reason: 'badId' };
    if (resending) return { ok: false, reason: 'busy' };
    const at = now();
    if (at - lastResendAt < RESEND_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastResendAt = at;
    resending = true;
    try {
      const res = await deps.resendRunEmail(planId);
      if (res && res.ok) return { ok: true };
      const reason = res && res.reason;
      return { ok: false, reason: RESEND_REASONS.has(reason) ? reason : 'failed' };
    } catch (err) {
      console.error('[orchestra] resend email failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    } finally {
      resending = false;
    }
  });
}

module.exports = { register, isKnownRunId, RUN_ID_RE, RESEND_GAP_MS };
