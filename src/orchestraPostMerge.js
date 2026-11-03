// ============================================================================
// LunaCore - God Mode post-merge services (main process composition root)
// ----------------------------------------------------------------------------
// Builds the implementations of orchestraFinalize.js POST_MERGE_STEPS from
// the real git / npm helpers, so main.js only wires one object:
//   updateLocalBase  - ff the main checkout + npm ci (src/worktrees.js)
//   cleanupMergedRun - integration worktree + merged branches
//                      (src/orchestraCleanup.js); the run is also written to
//                      the settled-run ledger for the start-up sweep
//   releaseAfterMerge - "Create a new release after finish" (src/releaseCut.js)
//   applySupabaseActions - the run's migrations / edge functions
//                      (src/orchestraApplyActions.js, gated by Settings)
// and sweepAtStart(): the one-time start-up sweep of settled runs older
// than a day, with the same rules.
//
// Every side effect comes in through deps, so tests use fakes.
// ============================================================================

'use strict';

const path = require('path');
const worktrees = require('./worktrees');
const orchestraStore = require('./orchestraStore');
const { cleanupMergedRun, settledRunOf, withSettledRun, sweepSettledRuns, normalizeSettledRun } = require('./orchestraCleanup');
const { cutRelease, releaseResult } = require('./releaseCut');

/**
 * True when `inner` is `outer` or a folder inside it.
 * @param {string} outer
 * @param {string} inner
 */
function isInside(outer, inner) {
  if (typeof outer !== 'string' || typeof inner !== 'string' || !outer || !inner) return false;
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const GIT_DEFAULTS = {
  updateLocalBase: worktrees.updateLocalBase,
  listWorktrees: worktrees.listWorktrees,
  removeWorktree: worktrees.removeWorktree,
  pruneWorktrees: worktrees.pruneWorktrees,
  deleteMergedBranch: worktrees.deleteMergedBranch,
};

/**
 * @param {{
 *   appPath?: () => string|null,
 *   git?: Partial<typeof GIT_DEFAULTS>,
 *   store?: {loadSettledRuns: () => unknown[], saveSettledRuns: (list:object[]) => boolean},
 *   isKnownRepo?: (repoPath:string) => boolean,
 *   release?: (opts:{repoPath:string, base:string, landedSha:string|null}) => Promise<object>,
 *   applyActions?: (ctx:object) => Promise<object>,
 *   now?: () => number,
 *   log?: (line:string) => void,
 * }} deps
 *   release: releaseCut.cutRelease bound to its side effects (main gives
 *   it the tool env for gh); tests pass a fake
 *   applyActions: orchestraApplyActions.applyManualActions bound to the
 *   setting, the tool env and the ask service; without it the step is left out
 *   appPath: the folder LunaCore itself runs from - `npm ci` never runs
 *   there (it would delete the node_modules the running app loads from)
 *   isKnownRepo: the start-up sweep only touches registered projects
 */
function createPostMergeServices(deps = {}) {
  const git = { ...GIT_DEFAULTS, ...(deps.git || {}) };
  const store = deps.store || orchestraStore;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const isKnownRepo = deps.isKnownRepo || (() => false);
  const release = deps.release || ((opts) => cutRelease(opts, { log }));
  let swept = false;

  const skipInstall = (root) => {
    const app = deps.appPath ? deps.appPath() : null;
    return app && isInside(root, app) ? 'LunaCore runs from this checkout' : null;
  };
  const gitOps = {
    listWorktrees: (repo) => git.listWorktrees(repo),
    removeWorktree: (repo, root) => git.removeWorktree(repo, root),
    pruneWorktrees: (repo) => git.pruneWorktrees(repo),
    deleteMergedBranch: (repo, branch, base) => git.deleteMergedBranch(repo, branch, base),
  };

  /** Adds a landed run to the ledger, so a start a day later sweeps it again. */
  function recordSettled(run) {
    const entry = normalizeSettledRun(run);
    if (!entry) return;
    if (!store.saveSettledRuns(withSettledRun(store.loadSettledRuns(), entry))) log('could not save the settled-run ledger');
  }

  const impls = {
    updateLocalBase: (ctx) => git.updateLocalBase(ctx.repoPath, ctx.base, { skipInstall }),
    cleanupMergedRun: async (ctx) => {
      recordSettled(settledRunOf(ctx, now()));
      return cleanupMergedRun(ctx, gitOps);
    },
    // Only what the run's merge landed: releaseCut checks headSha is in HEAD.
    releaseAfterMerge: async (ctx) => {
      const res = await release({ repoPath: ctx.repoPath, base: ctx.base, landedSha: ctx.headSha });
      const result = releaseResult(res);
      log(result.released ? `released ${result.tag}: ${result.url || '-'}` : `release skipped: ${result.skipped || result.error}`);
      return result;
    },
    ...(typeof deps.applyActions === 'function' ? { applySupabaseActions: (ctx) => deps.applyActions(ctx) } : {}),
  };

  /**
   * The one-time start-up sweep (orchestraCleanup.sweepSettledRuns). The run
   * the board restored joins it when its merge landed and it is not in the
   * ledger yet. Swept and dropped runs leave the ledger; entries a finalize
   * wrote meanwhile are kept.
   * @param {object|null} [landed] orchestra.landedRun()
   */
  async function sweepAtStart(landed) {
    if (swept) return { swept: [], remaining: [] };
    swept = true;
    const stored = withSettledRun(store.loadSettledRuns(), null);
    const current = landed ? normalizeSettledRun(landed) : null;
    const runs = current && !stored.some((r) => r.planId === current.planId) ? [...stored, current] : stored;
    const res = await sweepSettledRuns({ runs, now: now(), isKnownRepo, cleanup: (run) => cleanupMergedRun(run, gitOps) });
    const keep = new Set(res.remaining.map((r) => r.planId));
    const done = new Set(runs.filter((r) => !keep.has(r.planId)).map((r) => r.planId));
    if (done.size) {
      const next = withSettledRun(store.loadSettledRuns(), null).filter((r) => !done.has(r.planId));
      if (!store.saveSettledRuns(next)) log('could not save the settled-run ledger');
    }
    for (const { planId, result } of res.swept) {
      const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
      log(`start-up sweep ${planId}: worktree ${result.worktree || '-'}, ${deleted} branches deleted${result.error ? `, ${result.error}` : ''}`);
    }
    return res;
  }

  return { impls, sweepAtStart };
}

module.exports = { createPostMergeServices, isInside };
