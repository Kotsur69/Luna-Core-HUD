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
//   4. report    - markdown in <userDir>/runs/<plan>.md + an OS notification,
//                  and the run for the phone's `godmode` snapshot.
//
// State lives in orchestra.js; this module gets accessors, never the object
// to keep.
// ============================================================================

'use strict';

const sup = require('./orchestraSupervisor');
const { topoOrder } = require('./orchestraPlan');
const { prBody } = require('./orchestraIntegrate');
const { buildReport, appendStallNotes } = require('./orchestraReport');
const { runEntry } = require('./godmodesnapshot');
const { selfCheckGate } = require('./orchestraSelfCheck');

// Lets a closed tab's processes let go of the worktree folder (Windows).
const TAB_CLOSE_SETTLE_MS = 2500;
const MAX_TODO_DETAILS = 4000;
const DEFAULT_CHECK_COMMAND = 'npm test';

/** The integration worktree / branch name part for a run: `luna/<slug>-integration`. */
const slugOf = (plan) => plan.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24) || 'run';

/**
 * @param {{
 *   getPlan: () => object|null, patch: (id:string, fields:object) => void,
 *   commit: () => void, view: () => object|null, onRunEvent: Function, now: () => number,
 *   createPr?: Function, integrateMerge?: Function, removeWorktree?: Function,
 *   closeSession?: Function, sessionAlive?: Function, updateTodos?: Function,
 *   writeReport?: Function, notify?: Function, putSnapshot?: Function, sleep?: (ms:number) => Promise<void>,
 *   onReport?: (planId:string, text:string, summary:object) => Promise<{error?:string}|void>,
 *   runSelfCheck?: (args:{root:string, baseSha:string|null, checkCommand:string}) => Promise<object>,
 *   runFixup?: (args:{root:string, brief:string}) => Promise<{ok:boolean}>,
 *   pushBranch?: (root:string, branch:string) => Promise<{ok:boolean}>,
 *   checkCommand?: () => string, onIdle?: () => void,
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

  const checkCommand = () => {
    const cmd = deps.checkCommand ? deps.checkCommand() : null;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : DEFAULT_CHECK_COMMAND;
  };
  const packagesFor = (todo) => todo.map((p) => ({ id: p.id, branch: p.branch, verify: p.verify, dependsOn: p.dependsOn || [] }));
  // Self-check results travel back with the integration result.
  const checked = (gate) => (gate ? { selfCheck: gate.selfCheck, manualActions: gate.manualActions } : {});

  async function mergeAll(plan, todo) {
    if (!deps.integrateMerge) return { ok: false, error: 'unavailable' };
    if (!todo.length) return { ok: true };
    const slug = slugOf(plan);
    let gate = null;
    // The self-check gate runs on the integration worktree right before the
    // base push (orchestraIntegrate.js deps.beforePush): one fix-up worker,
    // and a red result never reaches the base branch.
    const extra = deps.runSelfCheck
      ? {
          beforePush: async (root, info) => {
            gate = await selfCheckGate(
              { root, baseSha: (info && info.baseSha) || null, checkCommand: checkCommand(), slug },
              { runSelfCheck: deps.runSelfCheck, runFixup: deps.runFixup, pushBranch: deps.pushBranch },
            );
            return gate.ok ? { ok: true } : { ok: false, reason: gate.reason };
          },
        }
      : {};
    const res = await deps.integrateMerge({ base: plan.baseBranch, slug, packages: packagesFor(todo) }, extra);
    // Merges only count once they are pushed. Skipped packages do not fail
    // the integration: the rest landed, so it is a partial success.
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    if (res.ok) {
      for (const id of res.merged) deps.patch(id, { merged: true });
      return { ok: true, skipped, partial: skipped.length > 0, ...checked(gate) };
    }
    const detail = [res.failedId, res.detail].filter(Boolean).join(': ');
    // A red self-check is its own open question: the merged result sits on
    // luna/<slug>-integration (when that push worked), the base is untouched.
    const selfCheckRed = res.stage === 'beforePush' && gate && !gate.ok;
    return { ok: false, error: selfCheckRed ? 'selfCheckFailed' : `${res.stage}Failed`, detail: detail || null, skipped, ...checked(gate) };
  }

  /**
   * pr / branches modes: the same integration worktree, built as a throwaway
   * (card-2 skip rules), only to run the self-check. Never pushes, no fix-up
   * worker; only the results are kept. Free runs are left out: the merge
   * resolver is a paid Claude call.
   */
  async function checkOnly(plan) {
    if (!deps.integrateMerge || !deps.runSelfCheck || !plan.baseBranch || plan.freeMode) return {};
    const todo = ordered(plan, (p) => p.state === 'pushed' && p.branch);
    if (!todo.length) return {};
    let gate = null;
    try {
      await deps.integrateMerge(
        { base: plan.baseBranch, slug: `${slugOf(plan).slice(0, 18)}-check`, packages: packagesFor(todo), checkOnly: true },
        {
          beforePush: async (root, info) => {
            gate = await selfCheckGate(
              { root, baseSha: (info && info.baseSha) || null, checkCommand: checkCommand(), slug: slugOf(plan) },
              { runSelfCheck: deps.runSelfCheck },
            );
            return { ok: false, reason: 'checkOnly' };
          },
        },
      );
    } catch (err) {
      deps.onRunEvent('error', { where: 'selfCheck', message: err instanceof Error ? err.message : String(err) });
    }
    return checked(gate);
  }

  async function integrate(plan) {
    const mode = plan.integrationMode || 'branches';
    if (mode === 'branches') return { ok: true, ...(await checkOnly(plan)) };
    if (!plan.baseBranch) return { ok: false, error: 'noBaseBranch' };
    // The checkout must still be on the branch the plan was made on - the
    // stored name is never trusted alone to pick what gets PRs or a push.
    if (deps.currentBaseBranch && (await deps.currentBaseBranch()) !== plan.baseBranch) {
      return { ok: false, error: 'baseMoved', detail: plan.baseBranch };
    }
    if (mode === 'pr') {
      const prs = await openPrs(plan, ordered(plan, (p) => p.state === 'pushed' && !p.prUrl && p.branch));
      return { ...prs, ...(await checkOnly(plan)) };
    }
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

  // The phone's God Mode page (godmodesnapshot.js). main puts it only while
  // logged in to the cloud; nothing here may break the end of a run.
  function putSnapshot(view, extra) {
    if (!deps.putSnapshot) return;
    try {
      Promise.resolve(deps.putSnapshot(runEntry(view, extra))).catch((err) =>
        console.error('[cloudsnapshots] put godmode failed:', err instanceof Error ? err.message : String(err)),
      );
    } catch (err) {
      console.error('[cloudsnapshots] put godmode failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The run email (godmodemail.js), fire and forget. A failure never breaks
   * finalize: it lands on the board (integration.emailError) and at the end
   * of the report file.
   */
  function sendReport(plan, view, extra, text) {
    if (!deps.onReport) return;
    const integ = plan.integration || {};
    const summary = {
      ...runEntry(view, extra),
      integrationError: integ.error ? [integ.error, integ.detail].filter(Boolean).join(': ') : null,
    };
    const failed = (reason) => {
      if (deps.getPlan() !== plan) return;
      setIntegration(plan, { emailError: String(reason).slice(0, 80) });
      if (deps.writeReport) deps.writeReport(plan.id, `${text}
- Email failed: ${String(reason).slice(0, 80)}
`);
      deps.commit();
    };
    setIntegration(plan, { emailError: null });
    try {
      Promise.resolve(deps.onReport(plan.id, text, summary))
        .then((res) => {
          if (res && res.error) failed(res.error);
        })
        .catch((err) => failed((err && err.reason) || 'failed'));
    } catch (err) {
      failed((err && err.reason) || 'failed');
    }
  }

  function report(plan) {
    const view = { ...deps.view(), repoPath: plan.repoPath };
    const extra = { now: deps.now(), suggestions: sup.allowSuggestions(plan.approvalLog) };
    const text = buildReport(view, extra);
    const file = deps.writeReport ? deps.writeReport(plan.id, text) : null;
    const pushed = plan.packages.filter((p) => p.state === 'pushed').length;
    if (deps.notify) deps.notify({ pushed, total: plan.packages.length, failed: plan.integration.state === 'failed' });
    putSnapshot(view, { ...extra, report: text });
    sendReport(plan, view, extra, text);
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
      } else if (deps.onIdle) {
        // Every pass done, state committed: the shutdown option may act now.
        deps.onIdle();
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
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    // Kept from the last check when this pass ran none (nothing new to merge).
    if (res.selfCheck) setIntegration(plan, { selfCheck: res.selfCheck, manualActions: res.manualActions || [] });
    setIntegration(
      plan,
      res.ok
        ? { state: 'done', error: null, detail: null, at: deps.now(), skipped, partial: skipped.length > 0 }
        : { state: 'failed', error: res.error || 'failed', detail: res.detail || null, at: deps.now(), skipped, partial: false },
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
