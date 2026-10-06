// ============================================================================
// LunaCore - God Mode v2 end of run (ORCHESTRATOR_PLAN.md slice 5, §5 + §6)
// ----------------------------------------------------------------------------
// When a run settles (nothing running, nothing launchable) - or Mati presses
// "Finish run" - this does, in order:
//
//   1. integrate - per the run's mode (orchestraIntegrate.js): PRs, merge to
//                  the base branch, or nothing. Idempotent per package
//                  (prUrl / merged), so a rerun after a Retry only does the
//                  new ones.
//   2. cleanup   - close pushed packages' tabs, remove their worktrees (the
//                  branch is on the remote). Stalled ones stay for inspection.
//   3. notes     - unfinished packages leave a note on their to-dos.
//   4. report    - markdown in <userDir>/runs/<plan>.md + an OS notification.
//
// State lives in orchestra.js; this module gets accessors, never the object
// to keep.
// ============================================================================

'use strict';

const sup = require('./orchestraSupervisor');
const { topoOrder } = require('./orchestraPlan');
const { prBody } = require('./orchestraIntegrate');
const { buildReport, appendStallNotes } = require('./orchestraReport');

// Lets a closed tab's processes let go of the worktree folder (Windows).
const TAB_CLOSE_SETTLE_MS = 2500;
const MAX_TODO_DETAILS = 4000;

/**
 * @param {{
 *   getPlan: () => object|null, patch: (id:string, fields:object) => void,
 *   commit: () => void, view: () => object|null, onRunEvent: Function, now: () => number,
 *   createPr?: Function, integrateMerge?: Function, removeWorktree?: Function,
 *   closeSession?: Function, sessionAlive?: Function, updateTodos?: Function,
 *   writeReport?: Function, notify?: Function, sleep?: (ms:number) => Promise<void>,
 * }} deps
 */
function createFinalizer(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let running = false;
  // A settle that came in while finalizing (a package pushed by hand meanwhile).
  let again = false;

  const setIntegration = (plan, fields) => {
    plan.integration = { ...plan.integration, ...fields };
  };

  function ordered(plan, pick) {
    const { order } = topoOrder(plan.packages);
    const byId = new Map(plan.packages.map((p) => [p.id, p]));
    return order.map((id) => byId.get(id)).filter((p) => p && pick(p));
  }

  async function openPrs(plan, todo) {
    if (!deps.createPr) return { ok: false, error: 'unavailable' };
    const view = deps.view();
    const overlaps = sup.liveOverlaps(plan.packages);
    const branchOf = (id) => (plan.packages.find((p) => p.id === id) || {}).branch || null;
    let firstError = null;
    for (const pkg of todo) {
      const v = view.packages.find((p) => p.id === pkg.id);
      const body = prBody(v, { notes: plan.notes, overlaps, branchOf });
      const res = await deps.createPr({ base: plan.baseBranch, branch: pkg.branch, title: pkg.title || pkg.id, body });
      if (res.ok) deps.patch(pkg.id, { prUrl: res.url });
      else firstError = firstError || { error: res.error, detail: res.detail || null };
      deps.commit();
    }
    return firstError ? { ok: false, ...firstError } : { ok: true };
  }

  async function mergeAll(plan, todo) {
    if (!deps.integrateMerge) return { ok: false, error: 'unavailable' };
    if (!todo.length) return { ok: true };
    const res = await deps.integrateMerge({
      base: plan.baseBranch,
      slug: plan.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24) || 'run',
      packages: todo.map((p) => ({ id: p.id, branch: p.branch, verify: p.verify })),
    });
    // Merges only count once they are pushed; a red run pushed nothing.
    if (res.ok) {
      for (const id of res.merged) deps.patch(id, { merged: true });
      return { ok: true };
    }
    const detail = [res.failedId, res.detail].filter(Boolean).join(': ');
    return { ok: false, error: `${res.stage}Failed`, detail: detail || null };
  }

  async function integrate(plan) {
    const mode = plan.integrationMode || 'branches';
    if (mode === 'branches') return { ok: true };
    if (!plan.baseBranch) return { ok: false, error: 'noBaseBranch' };
    // The checkout must still be on the branch the plan was made on - the
    // stored name is never trusted alone to pick what gets PRs or a push.
    if (deps.currentBaseBranch && (await deps.currentBaseBranch()) !== plan.baseBranch) {
      return { ok: false, error: 'baseMoved', detail: plan.baseBranch };
    }
    if (mode === 'pr') return openPrs(plan, ordered(plan, (p) => p.state === 'pushed' && !p.prUrl && p.branch));
    return mergeAll(plan, ordered(plan, (p) => p.state === 'pushed' && !p.merged && p.branch));
  }

  async function cleanup(plan) {
    const done = plan.packages.filter((p) => p.state === 'pushed' && p.root && !p.cleaned);
    if (!done.length || !deps.removeWorktree) return;
    let closed = false;
    for (const p of done) {
      if (p.sessionId && deps.sessionAlive && deps.sessionAlive(p.sessionId) && deps.closeSession) {
        deps.closeSession(p.sessionId);
        closed = true;
      }
    }
    if (closed) await sleep(TAB_CLOSE_SETTLE_MS);
    for (const p of done) {
      const res = await deps.removeWorktree(plan.repoPath, p.root);
      if (res.ok) deps.patch(p.id, { cleaned: true, sessionId: null });
      else deps.onRunEvent('cleanupFailed', { id: p.id, error: res.error || 'gitFailed' });
    }
    deps.commit();
  }

  function leaveNotes(plan) {
    if (!deps.updateTodos) return;
    // A worker waiting on a prompt with its tab open is not given up on: Mati
    // answers it and it carries on - no note for that.
    const waiting = (p) =>
      p.state === 'stalled' && p.error === 'needsApproval' && p.sessionId && deps.sessionAlive && deps.sessionAlive(p.sessionId);
    const notable = plan.packages.filter((p) => !waiting(p));
    deps.updateTodos(plan.projectId, (list) => appendStallNotes(list, notable, plan.id, MAX_TODO_DETAILS));
  }

  function report(plan) {
    const text = buildReport(
      { ...deps.view(), repoPath: plan.repoPath },
      { now: deps.now(), suggestions: sup.allowSuggestions(plan.approvalLog) },
    );
    const file = deps.writeReport ? deps.writeReport(plan.id, text) : null;
    const pushed = plan.packages.filter((p) => p.state === 'pushed').length;
    if (deps.notify) deps.notify({ pushed, total: plan.packages.length, failed: plan.integration.state === 'failed' });
    return file;
  }

  /**
   * The end-of-run sequence. Never throws; one at a time.
   * @returns {Promise<boolean>} false when it did not run
   */
  async function finalize() {
    const plan = deps.getPlan();
    if (!plan) return false;
    if (running) {
      again = true;
      return false;
    }
    running = true;
    try {
      return await finalizeOnce(plan);
    } finally {
      running = false;
      if (again) {
        again = false;
        // Packages pushed meanwhile get their PR / merge / cleanup too.
        finalize().catch((err) => deps.onRunEvent('error', { where: 'finalize', message: String(err && err.message) }));
      }
    }
  }

  async function finalizeOnce(plan) {
    setIntegration(plan, { state: 'running', error: null, detail: null });
    deps.commit();
    let res;
    try {
      res = await integrate(plan);
    } catch (err) {
      res = { ok: false, error: 'integrateThrew', detail: err instanceof Error ? err.message.slice(0, 300) : null };
    }
    if (deps.getPlan() !== plan) return false; // discarded meanwhile
    setIntegration(
      plan,
      res.ok
        ? { state: 'done', error: null, detail: null, at: deps.now() }
        : { state: 'failed', error: res.error || 'failed', detail: res.detail || null, at: deps.now() },
    );
    deps.commit();
    try {
      await cleanup(plan);
      leaveNotes(plan);
      setIntegration(plan, { reportPath: report(plan) });
    } catch (err) {
      deps.onRunEvent('error', { where: 'finalize', message: err instanceof Error ? err.message : String(err) });
    }
    deps.commit();
    deps.onRunEvent('finalized', { ok: res.ok });
    return true;
  }

  return { finalize, isRunning: () => running };
}

module.exports = { createFinalizer, TAB_CLOSE_SETTLE_MS };
