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
// ============================================================================

'use strict';

const path = require('path');
const sup = require('./orchestraSupervisor');

const FIXUP_ID = 'selfcheck';
const FIXUP_CAP_MS = 45 * 60 * 1000;

/**
 * @param {{
 *   getPlan: () => object|null, createSession: Function, writeBrief: Function,
 *   briefDir: () => string, closeSession: Function, sessionAlive: Function,
 *   model: () => string|null, permissionMode: () => string|null, setTimer: Function, clearTimer: Function,
 * }} deps
 */
function createFixupRunner(deps) {
  /** @type {null|{sessionId:string, resolve:Function, timer:any}} */
  let current = null;

  function settle(ok) {
    if (!current) return;
    const { sessionId, resolve, timer } = current;
    current = null;
    if (timer) deps.clearTimer(timer);
    try {
      if (deps.sessionAlive(sessionId)) deps.closeSession(sessionId);
    } catch {
      /* a tab that will not close must not keep the run from ending */
    }
    resolve({ ok });
  }

  /**
   * @param {{root:string, brief:string}} args
   * @returns {Promise<{ok:boolean}>}
   */
  function run(args) {
    const plan = deps.getPlan();
    const o = args && typeof args === 'object' ? args : {};
    if (!plan || current || typeof o.root !== 'string' || !o.root || typeof o.brief !== 'string') {
      return Promise.resolve({ ok: false });
    }
    let session = null;
    try {
      const briefPath = path.join(deps.briefDir(), `${plan.id}-${FIXUP_ID}.md`);
      if (!deps.writeBrief(briefPath, o.brief)) return Promise.resolve({ ok: false });
      session = deps.createSession({
        profileId: plan.profileId,
        projectId: plan.projectId,
        cwd: o.root,
        branch: null,
        task: { briefPath, model: deps.model(), permissionMode: deps.permissionMode(), allowedTools: plan.allowedTools || [] },
      });
    } catch {
      session = null;
    }
    if (!session || !session.id) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      current = { sessionId: session.id, resolve, timer: null };
      const timer = deps.setTimer(() => settle(false), FIXUP_CAP_MS);
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
