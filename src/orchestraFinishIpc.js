// ============================================================================
// LunaCore - God Mode finished-run IPC (main process)
// ----------------------------------------------------------------------------
// orchestra:resend-email {planId}         -> {ok} | {ok:false, reason}
//   "Resend report email" on the finished run: the run's report email again
//   (godmodePending.resend), same report text and HTML attachment.
// orchestra:unreleased-count {projectId}  -> {ok, count, tag} | {ok:false, reason}
//   commits since the last v* tag in the project's checkout (read-only)
// orchestra:release-now {projectId}       -> {ok, version, url} | {ok:false, reason}
//   "Release now" (src/releaseCut.js) for the finished run on the board
//
// The renderer is never trusted:
//   - a run id must be a plain lower-case id (RUN_ID_RE - no dots, no path
//     separators) AND name a report main wrote (<runsDir>/<id>.md is a
//     regular file, not a link);
//   - a project id must be one of the registered projects; Release now also
//     needs it to be the board's run, whose merge landed, in that project's
//     folder - and Mati confirms it in a native dialog, which the renderer
//     can ask for but never answer;
//   - one resend / one release at a time; resends at least RESEND_GAP_MS
//     apart.
// Lives outside main.js (past the file-size guideline); main.js wires it with
// one register() call.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_PROJECT_ID = 100;
const RESEND_GAP_MS = 15 * 1000;
// After Mati declines "Release now" the dialog does not come back at once.
const DECLINE_COOLDOWN_MS = 30 * 1000;
// Resend failure reasons the board has words for; anything else is 'failed'.
const RESEND_REASONS = new Set([
  'badId', 'unknownRun', 'busy', 'rate-limited', 'gmail-not-connected', 'no-report', 'gmail-network',
  'gmail-timeout', 'gmail-auth', 'gmail-scope', 'gmail-no-client', 'gmail-failed',
]);
const MAX_REASON = 300;

// eslint-disable-next-line no-control-regex
const reasonText = (v) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_REASON) || 'failed';

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
 * A project id from the renderer, checked against the registered projects.
 * @returns {{id:string, path:string}|null}
 */
function knownProject(projects, id) {
  if (typeof id !== 'string' || !id || id.length > MAX_PROJECT_ID) return null;
  const list = Array.isArray(projects()) ? projects() : [];
  const hit = list.find((p) => p && p.id === id && typeof p.path === 'string' && p.path);
  return hit ? { id: hit.id, path: hit.path } : null;
}

// Windows paths compare case-insensitively; elsewhere exactly.
const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && !!a && !!b && pathKey(a) === pathKey(b);

/** The report / board line for a Release now answer. */
function releaseLine(res) {
  if (res && res.ok) return `- Released ${res.tag}: ${res.url || 'no release URL'}`;
  if (res && res.refused) return `- Release skipped: ${reasonText(res.reason)}`;
  return `- Release failed: ${reasonText(res ? `${res.stage}: ${res.reason}` : 'failed')}`;
}

/**
 * @param {{handle: Function}} ipcMain
 * @param {{
 *   runsDir: () => string|null,
 *   resendRunEmail: (planId:string) => Promise<{ok:boolean, reason?:string}>,
 *   projects?: () => Array<{id:string, path:string}>,
 *   releaseTarget?: () => {planId:string, projectId:string, repoPath:string, base:string|null,
 *     headSha:string|null, landed:boolean, releaseAfter:boolean, released:boolean, busy:boolean}|null,
 *   unreleasedCount?: (repoPath:string) => Promise<{ok:boolean, count?:number, tag?:string, reason?:string}>,
 *   cutRelease?: (opts:{repoPath:string, base:string, landedSha:string}) => Promise<object>,
 *   releaseResult?: (res:object) => object,
 *   recordRelease?: (planId:string, result:object) => void,
 *   appendReport?: (planId:string, line:string) => void,
 *   confirmRelease?: (info:{base:string, count:number|null}) => Promise<boolean>,
 *   now?: () => number,
 * }} deps
 */
function register(ipcMain, deps) {
  const now = deps.now || Date.now;
  const projects = deps.projects || (() => []);
  let resending = false;
  let lastResendAt = -Infinity;
  let releasing = false;
  let declinedAt = -Infinity;

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

  ipcMain.handle('orchestra:unreleased-count', async (_event, projectId) => {
    const project = knownProject(projects, projectId);
    if (!project || !deps.unreleasedCount) return { ok: false, reason: 'unknownProject' };
    try {
      const res = await deps.unreleasedCount(project.path);
      return res && res.ok ? { ok: true, count: res.count, tag: res.tag } : { ok: false, reason: reasonText(res && res.reason) };
    } catch (err) {
      console.error('[orchestra] unreleased count failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  /** Why the board's run cannot be released for `project` now, or null. */
  function releaseRefusal(project, target) {
    if (!target || target.projectId !== project.id || !samePath(target.repoPath, project.path)) return 'noRun';
    if (!target.landed || !target.base) return 'run not landed on base';
    if (target.released) return 'already released';
    if (target.busy) return 'busy';
    return null;
  }

  ipcMain.handle('orchestra:release-now', async (_event, projectId) => {
    const project = knownProject(projects, projectId);
    if (!project || !deps.cutRelease || !deps.releaseTarget) return { ok: false, reason: 'unknownProject' };
    const target = deps.releaseTarget();
    const refusal = releaseRefusal(project, target);
    if (refusal) return { ok: false, reason: refusal };
    if (releasing) return { ok: false, reason: 'busy' };
    if (now() - declinedAt < DECLINE_COOLDOWN_MS) return { ok: false, reason: 'declined' };
    releasing = true;
    try {
      let count = null;
      if (deps.unreleasedCount) {
        const since = await deps.unreleasedCount(target.repoPath).catch(() => null);
        count = since && since.ok ? since.count : null;
      }
      if (!deps.confirmRelease || !(await deps.confirmRelease({ base: target.base, count }))) {
        declinedAt = now();
        return { ok: false, reason: 'declined' };
      }
      // The dialog may have been open a while: the run must still be the same one, untouched.
      const after = deps.releaseTarget();
      const changed = releaseRefusal(project, after);
      if (changed) return { ok: false, reason: changed };
      if (after.planId !== target.planId || after.headSha !== target.headSha) return { ok: false, reason: 'noRun' };
      const res = await deps.cutRelease({ repoPath: target.repoPath, base: target.base, landedSha: target.headSha });
      if (deps.recordRelease && deps.releaseResult) deps.recordRelease(target.planId, deps.releaseResult(res));
      if (deps.appendReport) deps.appendReport(target.planId, releaseLine(res));
      if (res && res.ok) return { ok: true, version: res.version, tag: res.tag, url: res.url || null };
      return { ok: false, reason: reasonText(res && res.reason) };
    } catch (err) {
      console.error('[orchestra] release now failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    } finally {
      releasing = false;
    }
  });
}

module.exports = { register, isKnownRunId, knownProject, releaseLine, RUN_ID_RE, RESEND_GAP_MS };
