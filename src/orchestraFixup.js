// ============================================================================
// LunaCore - God Mode v2 self-check fix-up worker ("GM never blocks" 4/5)
// ----------------------------------------------------------------------------
// One normal worker tab in the integration worktree when the end-of-run
// self-check is red (orchestraSelfCheck.js selfCheckGate). It is NOT a
// package: it never enters plan.packages, never counts in the tally and never
// reopens a settled run. It resolves on `LUNA_DONE selfcheck` /
// `LUNA_BLOCKED selfcheck` (the supervisor's own turn-end marker parsing with
// the synthetic id 'selfcheck'), when its tab closes, or after a 45 min cap;
// the tab is closed afterwards. One at a time. Never throws.
//
// The merge itself uses the same runner (orchestraMergeFixup.js): a package
// red right after its merge gets one fix-up, with a shorter cap, before it
// is taken back out.
// ============================================================================

'use strict';

const path = require('path');
const sup = require('./orchestraSupervisor');
const { godModeTask, SELFCHECK_PACKAGE_ID, FIXUP_PACKAGE_ID } = require('./orchestraFollowupsLaunch');
const { withFollowupBrief } = require('./orchestraFollowups');
const { briefPathIn } = require('./workerBrief');

const FIXUP_ID = 'selfcheck';
const FIXUP_CAP_MS = 45 * 60 * 1000;
// Which fix-up a tab is, for the follow-up channel's record: the end-of-run
// self-check's ('selfcheck') or a package's merge fix-up ('fixup').
const FIXUP_KINDS = new Set([SELFCHECK_PACKAGE_ID, FIXUP_PACKAGE_ID]);

/**
 * @param {{
 *   getPlan: () => object|null, createSession: Function, writeBrief: Function,
 *   removeBrief?: (file:string) => boolean, closeSession: Function, sessionAlive: Function,
 *   profileId?: () => string|null, strictProfile?: () => boolean, strictBackend?: () => string|null,
 *   model: () => string|null, effort?: () => string|null, permissionMode: () => string|null, setTimer: Function, clearTimer: Function,
 *   revokeFollowups?: (list:Array<{sessionId:string, runId:string, packageId:string}>) => void,
 * }} deps
 */
function createFixupRunner(deps) {
  /** @type {null|{sessionId:string, resolve:Function, timer:any, runId:string, packageId:string, briefPath:string|null}} */
  let current = null;

  /** Deletes a fix-up brief; a failure is logged, never thrown. */
  function dropBrief(file) {
    if (!file || typeof deps.removeBrief !== 'function') return;
    try {
      deps.removeBrief(file);
    } catch (err) {
      console.error('[orchestra] fix-up brief not removed:', err instanceof Error ? err.message : String(err));
    }
  }

  function settle(ok) {
    if (!current) return;
    const { sessionId, resolve, timer, runId, packageId, briefPath } = current;
    current = null;
    if (timer) deps.clearTimer(timer);
    // The fix-up is over: its brief goes (the next fix-up writes its own).
    dropBrief(briefPath);
    // The follow-up channel closes with the fix-up, whether or not its tab does.
    try {
      if (deps.revokeFollowups) deps.revokeFollowups([{ sessionId, runId, packageId }]);
    } catch (err) {
      console.error('[orchestra] fix-up token not revoked:', err instanceof Error ? err.message : String(err));
    }
    try {
      if (deps.sessionAlive(sessionId)) deps.closeSession(sessionId);
    } catch {
      /* a tab that will not close must not keep the run from ending */
    }
    resolve({ ok });
  }

  /**
   * @param {{root:string, brief:string, capMs?:number, packageId?:string}} args capMs: a
   *   shorter cap (the merge fix-up's 20 min); never longer than 45 min.
   *   packageId: 'selfcheck' (default) or 'fixup' (a merge fix-up)
   * @returns {Promise<{ok:boolean}>}
   */
  function run(args) {
    const plan = deps.getPlan();
    const o = args && typeof args === 'object' ? args : {};
    if (!plan || current || typeof o.root !== 'string' || !o.root || typeof o.brief !== 'string') {
      return Promise.resolve({ ok: false });
    }
    const packageId = FIXUP_KINDS.has(o.packageId) ? o.packageId : SELFCHECK_PACKAGE_ID;
    const profileId = deps.profileId ? deps.profileId() : plan.profileId;
    const strict = !!(deps.strictProfile && deps.strictProfile());
    const strictBackend = deps.strictBackend ? deps.strictBackend() : null;
    if (strict && !profileId) return Promise.resolve({ ok: false });
    let session = null;
    let briefPath = null;
    // One folder for both the tab and its brief, so the brief's relative name holds.
    const cwd = path.isAbsolute(o.root) ? o.root : path.resolve(o.root);
    try {
      // Inside the tab's own cwd (src/workerBrief.js): no --add-dir, no trust prompt.
      briefPath = briefPathIn(cwd, `${plan.id}-${FIXUP_ID}`.replace(/[^A-Za-z0-9._-]/g, '_'));
      // The self-check and merge fix-up briefs get the follow-up section here, only with the option on.
      if (!deps.writeBrief(briefPath, withFollowupBrief(o.brief, plan.followups === true))) return Promise.resolve({ ok: false });
      const task = { briefPath, model: deps.model(), effort: deps.effort ? deps.effort() : null, permissionMode: deps.permissionMode(), allowedTools: plan.allowedTools || [] };
      session = deps.createSession({
        ...(strict ? { strictProfile: true } : {}),
        ...(strict && strictBackend ? { strictBackend } : {}),
        profileId,
        projectId: plan.projectId,
        cwd,
        branch: null,
        task: godModeTask(task, { runId: plan.id, packageId, followups: plan.followups === true }),
      });
    } catch (err) {
      console.error('[orchestra] fix-up tab not started:', err instanceof Error ? err.message : String(err));
      session = null;
    }
    if (!session || !session.id) {
      dropBrief(briefPath);
      return Promise.resolve({ ok: false });
    }
    return new Promise((resolve) => {
      current = { sessionId: session.id, resolve, timer: null, runId: plan.id, packageId, briefPath };
      const cap = Number.isFinite(o.capMs) && o.capMs > 0 ? Math.min(o.capMs, FIXUP_CAP_MS) : FIXUP_CAP_MS;
      const timer = deps.setTimer(() => settle(false), cap);
      // A real timer must not keep a test process (or a quitting app) alive.
      if (timer && typeof timer.unref === 'function') timer.unref();
      if (current) current.timer = timer;
    });
  }

  /** @returns {boolean} true when the turn belonged to the fix-up tab */
  function onTurnEnd(sessionId, fragment) {
    if (!current || sessionId !== current.sessionId) return false;
    const marker = sup.markerFrom(fragment, FIXUP_ID);
    // No marker: the worker is still going (or waits); the cap ends it.
    if (marker) settle(marker.kind === 'done');
    return true;
  }

  /** @returns {boolean} true when the closed tab was the fix-up tab */
  function onSessionClosed(sessionId) {
    if (!current || sessionId !== current.sessionId) return false;
    settle(false);
    return true;
  }

  return {
    run,
    onTurnEnd,
    onSessionClosed,
    owns: (sessionId) => !!current && sessionId === current.sessionId,
    abort: () => settle(false),
  };
}

module.exports = { createFixupRunner, FIXUP_ID, FIXUP_CAP_MS };
