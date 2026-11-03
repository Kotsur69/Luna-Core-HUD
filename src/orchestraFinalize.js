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
//   3. post-merge - only when this pass merged into the base branch: the
//                  POST_MERGE_STEPS below, in order (update the local base
//                  checkout, clean up merged branches, ...). Each result lands in
//                  integration.postMerge[<step>] for the board and report.
//   4. notes     - unfinished packages leave a note on their to-dos.
//   5. report    - markdown in <userDir>/runs/<plan>.md + an OS notification,
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
const { branchFor } = require('./worktrees');

// Lets a closed tab's processes let go of the worktree folder (Windows).
const TAB_CLOSE_SETTLE_MS = 2500;
const MAX_TODO_DETAILS = 4000;
const DEFAULT_CHECK_COMMAND = 'npm test';
// Integration stages a second try can fix on its own: the network, a
// leftover from an earlier pass (cleared at the start of the next one), a
// flaky install, a base that moved on during the push. Conflicts, red
// verifies and a red self-check are not retried - they need a human.
const RETRY_STAGES = new Set(['fetch', 'worktree', 'install', 'reset', 'push']);
const RETRY_DELAY_MS = 5000;
// emailError when Gmail is not connected in LunaCore (the board shows a hint).
const EMAIL_NOT_CONNECTED = 'gmail-not-connected';

/** The integration worktree / branch name part for a run: `luna/<slug>-integration`. */
const slugOf = (plan) => plan.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24) || 'run';

const errText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * What runs after a merge landed on the base branch, in this order - after
 * the package worktrees are cleaned up, before the report (so the report and
 * the run email carry the results). Per step:
 *   name  its result lands in integration.postMerge[name]
 *   impl  the deps.postMerge function doing the work, called with the
 *         post-merge context (postMergeContext); without it the step is
 *         left out
 *   when  (ctx) -> true to run, false to leave out silently, or a string:
 *         the reason it is skipped (kept as {skipped: reason})
 * A step that throws is recorded as {error} and the next one still runs.
 * Adding a step (e.g. 'apply Supabase actions') is one more entry here plus
 * its deps.postMerge implementation.
 */
const POST_MERGE_STEPS = Object.freeze([
  // 1. ff the main checkout when it is clean on the base branch (+ npm ci).
  { name: 'localBase', impl: 'updateLocalBase', when: () => true },
  // 2. remove the integration worktree, delete the merged package branches.
  { name: 'cleanup', impl: 'cleanupMergedRun', when: () => true },
  // 3. "Create a new release after finish" (src/releaseCut.js), once per run.
  { name: 'release', impl: 'releaseAfterMerge', when: releaseGate },
]);

const SELF_CHECK_KEYS = ['tests', 'syntax', 'smoke'];

/**
 * The release step runs only when Mati ticked it at Approve, at most once
 * per run (a later pass that merges more leaves a done release alone), and
 * only on a green self-check: its tests passed, nothing failed. The release
 * goes to every installed copy (auto-update), so a self-check that did not
 * run is not green. The rest (dirty tree, the merge not in the local
 * checkout, red tests, no gh) releaseCut refuses with its own reason.
 */
function releaseGate(ctx) {
  if (!ctx.options || ctx.options.releaseAfter !== true) return false;
  const done = ctx.previous && ctx.previous.release;
  if (done && done.released === true) return false;
  const sc = ctx.selfCheck;
  if (!sc || typeof sc !== 'object') return 'self-check did not run';
  if (SELF_CHECK_KEYS.some((k) => sc[k] === 'failed')) return 'self-check failed';
  if (sc.tests !== 'ok') return 'self-check tests did not run';
  return true;
}

/**
 * The read-only facts a post-merge step gets. `results` fills in as the
 * steps of this pass run; `previous` is what earlier passes of the run left.
 */
function postMergeContext(plan, res, slug) {
  const integ = plan.integration || {};
  const skippedIds = new Set((Array.isArray(res.skipped) ? res.skipped : []).map((s) => s && s.id));
  return {
    planId: plan.id,
    projectId: plan.projectId,
    repoPath: plan.repoPath,
    base: plan.baseBranch,
    headSha: res.headSha || null,
    integrationBranch: branchFor(`${slug}-integration`),
    packages: plan.packages.map((p) => ({
      id: p.id,
      branch: p.branch || null,
      merged: p.merged === true,
      skipped: skippedIds.has(p.id),
    })),
    options: sup.normalizeOptions(plan.options),
    selfCheck: integ.selfCheck || null,
    previous: { ...(integ.postMerge || {}) },
    results: {},
  };
}

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
    const args = { base: plan.baseBranch, slug, packages: packagesFor(todo) };
    let res = await deps.integrateMerge(args, extra);
    // A leftover worktree with local changes is refused every time - no retry.
    const leftover = /^leftover /.test(String(res.detail || ''));
    if (!res.ok && RETRY_STAGES.has(res.stage) && !leftover) {
      deps.onRunEvent('integrationRetry', { stage: res.stage, detail: res.detail || null });
      await sleep(RETRY_DELAY_MS);
      gate = null;
      res = await deps.integrateMerge(args, extra);
    }
    // Merges only count once they are pushed. Skipped packages do not fail
    // the integration: the rest landed, so it is a partial success.
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    if (res.ok) {
      for (const id of res.merged) deps.patch(id, { merged: true });
      // landed: this pass pushed merges onto the base branch (post-merge steps run).
      const landed = Array.isArray(res.merged) && res.merged.length > 0;
      return { ok: true, skipped, partial: skipped.length > 0, landed, slug, headSha: res.headSha || null, ...checked(gate) };
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

  /**
   * The POST_MERGE_STEPS, in order, after a pass that merged into the base
   * branch. Never throws; stops when the plan was discarded meanwhile.
   */
  async function runPostMerge(plan, res) {
    const impls = deps.postMerge || {};
    if (!res.landed || !plan.baseBranch) return;
    const ctx = postMergeContext(plan, res, res.slug || slugOf(plan));
    for (const step of POST_MERGE_STEPS) {
      const fn = impls[step.impl];
      if (typeof fn !== 'function') continue;
      const gate = step.when(ctx);
      if (gate === false) continue;
      let result;
      if (typeof gate === 'string') {
        result = { skipped: gate };
      } else {
        try {
          result = (await fn(ctx)) || {};
        } catch (err) {
          result = { error: errText(err) };
        }
      }
      if (deps.getPlan() !== plan) return;
      ctx.results[step.name] = result;
      const postMerge = { ...(plan.integration.postMerge || {}), [step.name]: { ...result, at: deps.now() } };
      setIntegration(plan, { postMerge });
      deps.commit();
      deps.onRunEvent('postMerge', { step: step.name });
    }
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

  /** What the run email is built from: godmodesnapshot.runEntry + the integration error. */
  function runSummary(plan, view, extra) {
    const integ = plan.integration || {};
    return {
      ...runEntry(view, extra),
      integrationError: integ.error ? [integ.error, integ.detail].filter(Boolean).join(': ') : null,
    };
  }

  /**
   * The run email (godmodemail.js), fire and forget. A failure never breaks
   * finalize: it lands on the board (integration.emailError) and at the end
   * of the report file. A transient one (Gmail not connected, rate-limited,
   * busy) comes back `pending` (godmodePending.js): it goes out once Gmail
   * connects or on the next start (integration.emailPending).
   */
  function sendReport(plan, view, extra, text) {
    if (!deps.onReport) return;
    const summary = runSummary(plan, view, extra);
    const failed = (reason, pending) => {
      if (deps.getPlan() !== plan) return;
      setIntegration(plan, { emailError: String(reason).slice(0, 80), emailPending: pending === true });
      if (deps.writeReport) deps.writeReport(plan.id, `${text}
- Email failed: ${String(reason).slice(0, 80)}
`);
      deps.commit();
    };
    setIntegration(plan, { emailError: null, emailPending: false });
    try {
      Promise.resolve(deps.onReport(plan.id, text, summary))
        .then((res) => {
          if (res && res.error) failed(res.error, res.pending);
          else if (res && res.skipped === 'not-connected') failed(EMAIL_NOT_CONNECTED, res.pending);
        })
        .catch((err) => failed((err && err.reason) || 'failed'));
    } catch (err) {
      failed((err && err.reason) || 'failed');
    }
  }

  /**
   * The current run's email summary (for "Resend report email"), or null
   * when `planId` is not the run on the board.
   */
  function emailSummary(planId) {
    const plan = deps.getPlan();
    if (!plan || plan.id !== planId) return null;
    const view = { ...deps.view(), repoPath: plan.repoPath };
    return runSummary(plan, view, { now: deps.now(), suggestions: sup.allowSuggestions(plan.approvalLog) });
  }

  /**
   * A later send of the run email (pending flush, Resend) reached its end:
   * the board's email line follows. Ignored for a run that is not on the board.
   * @param {string} planId
   * @param {{sent:boolean, reason:string|null}} res
   * @returns {boolean} whether the board's run was updated
   */
  function emailResult(planId, res) {
    const plan = deps.getPlan();
    if (!plan || plan.id !== planId || !res || typeof res !== 'object') return false;
    const reason = res.sent ? null : String(res.reason || 'failed').slice(0, 80);
    setIntegration(plan, { emailError: reason, emailPending: false });
    deps.commit();
    return true;
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
    // startedAt: the board shows how long the step has really been running.
    setIntegration(plan, { state: 'running', error: null, detail: null, startedAt: deps.now() });
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
    // The base head this run landed: "Release now" checks it reached the checkout.
    if (res.landed && res.headSha) setIntegration(plan, { headSha: res.headSha });
    deps.commit();
    try {
      await cleanup(plan);
      await runPostMerge(plan, res);
      if (deps.getPlan() !== plan) return false;
      leaveNotes(plan);
      setIntegration(plan, { reportPath: report(plan) });
    } catch (err) {
      deps.onRunEvent('error', { where: 'finalize', message: err instanceof Error ? err.message : String(err) });
    }
    deps.commit();
    deps.onRunEvent('finalized', { ok: res.ok });
    return true;
  }

  /**
   * A post-merge step run by hand after finalize ("Release now"): its result
   * lands in integration.postMerge[step] like the automatic ones.
   * @returns {boolean} whether the board's run was updated
   */
  function recordPostMerge(planId, step, result) {
    const plan = deps.getPlan();
    if (!plan || plan.id !== planId || !POST_MERGE_STEPS.some((s) => s.name === step) || !result || typeof result !== 'object') return false;
    const postMerge = { ...((plan.integration && plan.integration.postMerge) || {}), [step]: { ...result, at: deps.now() } };
    setIntegration(plan, { postMerge });
    deps.commit();
    deps.onRunEvent('postMerge', { step });
    return true;
  }

  return { finalize, isRunning: () => running, emailSummary, emailResult, recordPostMerge };
}

module.exports = { createFinalizer, postMergeContext, releaseGate, slugOf, POST_MERGE_STEPS, TAB_CLOSE_SETTLE_MS, EMAIL_NOT_CONNECTED };
