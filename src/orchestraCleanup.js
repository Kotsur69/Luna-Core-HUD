// ============================================================================
// LunaCore - God Mode branch hygiene
// ----------------------------------------------------------------------------
// A launch creates worktree + branch `luna/<pkgId>-<stamp>` first and can
// still fail afterwards (brief, tab, an exception). cleanupFailedLaunch()
// removes both, so a failed launch leaves nothing behind.
//
// sweepOrphanBranches() catches what older builds (or a crash) left: local
// `luna/<pkgId>-<stamp>` branches for THIS plan's package ids that no
// worktree has checked out and no package records. src/worktrees.js
// deleteBranch() still refuses each one that carries its own commits, so
// real work is never deleted.
//
// cleanupMergedRun() is the post-merge step (orchestraFinalize.js): the
// run's integration worktree goes (node_modules junctions unlinked first,
// then `git worktree remove` + prune), and every local package branch
// origin/<base> already contains is deleted. Skipped / unmerged packages
// keep their branches; remote branches are never touched.
// sweepSettledRuns() applies the same rules once at LunaCore start to
// settled runs older than a day (the ones a locked file or a crash left).
//
// Every function resolves a typed result and never rejects.
// ============================================================================

'use strict';

const path = require('path');

// orchestra.js names a launch `${pkg.id}-${stamp}`, stamp = 5 base-36 chars.
const STAMP_RE = /^[0-9a-z]{5}$/;
const BRANCH_PREFIX = 'luna/';
// Same rules as worktrees.js OWN_BRANCH_RE / isSafeBase; the ledger is a file
// on disk, so every value is checked before it reaches git.
const OWN_BRANCH_RE = /^luna\/[a-z0-9][a-z0-9-]{0,63}$/;
const BASE_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const PKG_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PACKAGES = 50;
// Settled runs the start-up sweep remembers (oldest dropped first).
const MAX_SETTLED_RUNS = 50;
// A settled run is swept at start once it is older than this.
const SETTLED_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

const errMessage = (err) => (err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
const isBase = (v) => typeof v === 'string' && BASE_BRANCH_RE.test(v) && !v.includes('..') && !v.endsWith('.lock');

/**
 * Removes a failed launch's worktree, then its branch (a branch checked out
 * in a worktree cannot be deleted, so the order matters).
 * @param {{removeWorktree?: Function, deleteBranch?: Function}} git
 * @param {string} repoPath
 * @param {{root?:string|null, branch?:string|null}} wt the addWorktree result
 * @param {string|null} base the sha the branch was created from
 * @returns {Promise<{removed:boolean, deleted:boolean, error:string|null}>}
 */
async function cleanupFailedLaunch(git, repoPath, wt, base) {
  const out = { removed: false, deleted: false, error: null };
  if (!wt) return out;
  try {
    if (wt.root && git.removeWorktree) {
      const res = await git.removeWorktree(repoPath, wt.root);
      out.removed = !!(res && res.ok);
      if (!out.removed) out.error = `worktree:${(res && res.error) || 'failed'}`;
    }
    if (wt.branch && git.deleteBranch && (out.removed || !wt.root)) {
      const res = await git.deleteBranch(repoPath, wt.branch, { base: base || null });
      out.deleted = !!(res && res.ok);
      if (!out.deleted) out.error = `branch:${(res && res.error) || 'failed'}`;
    }
  } catch (err) {
    out.error = errMessage(err);
  }
  return out;
}

/**
 * The branch's package id when it looks like one of this plan's launches.
 * @param {string} branch
 * @param {string[]} ids
 * @returns {string|null}
 */
function launchIdOf(branch, ids) {
  if (typeof branch !== 'string' || !branch.startsWith(BRANCH_PREFIX)) return null;
  const name = branch.slice(BRANCH_PREFIX.length);
  return ids.find((id) => name.startsWith(`${id}-`) && STAMP_RE.test(name.slice(id.length + 1))) || null;
}

/**
 * Pure: which local branches are this plan's orphaned launch branches.
 * @param {{branches:string[], checkedOut:string[], packages:Array<{id:string, branch?:string|null}>}} input
 * @returns {string[]}
 */
function orphanBranches({ branches, checkedOut, packages }) {
  const ids = packages.map((p) => p.id);
  const recorded = new Set(packages.map((p) => p.branch).filter(Boolean));
  const busy = new Set(checkedOut);
  return branches.filter((b) => launchIdOf(b, ids) && !recorded.has(b) && !busy.has(b));
}

/**
 * Deletes this plan's orphaned launch branches that have no own commits.
 * @param {{repoPath:string, packages:Array<{id:string, branch?:string|null}>,
 *   git:{listOwnBranches:Function, worktreeBranches:Function, deleteBranch:Function}}} args
 * @returns {Promise<{ok:boolean, deleted:string[], kept:Array<{branch:string, error:string}>, error?:string}>}
 */
async function sweepOrphanBranches({ repoPath, packages, git }) {
  try {
    const [branches, checkedOut] = await Promise.all([git.listOwnBranches(repoPath), git.worktreeBranches(repoPath)]);
    // Without the worktree list a checked-out branch cannot be told apart.
    if (!Array.isArray(branches) || !Array.isArray(checkedOut)) {
      return { ok: false, deleted: [], kept: [], error: 'gitFailed' };
    }
    const deleted = [];
    const kept = [];
    for (const branch of orphanBranches({ branches, checkedOut, packages })) {
      const res = await git.deleteBranch(repoPath, branch);
      if (res && res.ok) deleted.push(branch);
      else kept.push({ branch, error: (res && res.error) || 'failed' });
    }
    return { ok: true, deleted, kept };
  } catch (err) {
    return { ok: false, deleted: [], kept: [], error: errMessage(err) };
  }
}

/**
 * Which branches a merged run may lose and which it keeps: merged packages
 * (and the integration branch) are candidates - git still checks each is
 * contained in origin/<base> - skipped / unmerged ones are kept outright.
 * @param {{integrationBranch?:string|null, packages:Array<{branch:string|null, merged:boolean, skipped:boolean}>}} run
 * @returns {{candidates:string[], kept:Array<{branch:string, reason:string}>}}
 */
function branchPlan(run) {
  const candidates = [];
  const kept = [];
  for (const p of Array.isArray(run.packages) ? run.packages : []) {
    if (!p || typeof p.branch !== 'string' || !OWN_BRANCH_RE.test(p.branch)) continue;
    if (p.skipped) kept.push({ branch: p.branch, reason: 'skipped' });
    else if (!p.merged) kept.push({ branch: p.branch, reason: 'notMerged' });
    else if (!candidates.includes(p.branch)) candidates.push(p.branch);
  }
  return { candidates, kept };
}

/**
 * The post-merge cleanup of one run (see the header).
 * @param {{repoPath:string, base:string, integrationBranch?:string|null,
 *   packages:Array<{id:string, branch:string|null, merged:boolean, skipped:boolean}>}} run
 * @param {{listWorktrees:Function, removeWorktree:Function, pruneWorktrees:Function, deleteMergedBranch:Function}} git
 * @returns {Promise<{ok:boolean, worktree:'removed'|'gone'|'kept', deleted:string[],
 *   kept:Array<{branch:string, reason:string}>, error:string|null}>}
 */
async function cleanupMergedRun(run, git) {
  const out = { ok: true, worktree: 'gone', deleted: [], kept: [], error: null };
  try {
    if (!run || !isBase(run.base)) return { ...out, ok: false, error: 'badBase' };
    const list = await git.listWorktrees(run.repoPath);
    if (!Array.isArray(list)) return { ...out, ok: false, error: 'gitFailed' };
    const integration = typeof run.integrationBranch === 'string' && OWN_BRANCH_RE.test(run.integrationBranch) ? run.integrationBranch : null;
    const wt = integration ? list.find((w) => w && w.branch === integration) : null;
    if (wt) {
      // removeWorktree unlinks node_modules junctions before git removes the folder.
      const res = await git.removeWorktree(run.repoPath, wt.root);
      out.worktree = res && res.ok ? 'removed' : 'kept';
      if (out.worktree === 'kept') out.kept.push({ branch: integration, reason: `worktree ${(res && res.error) || 'failed'}` });
    }
    await git.pruneWorktrees(run.repoPath);
    const { candidates, kept } = branchPlan(run);
    out.kept.push(...kept);
    if (integration && out.worktree !== 'kept') candidates.unshift(integration);
    for (const branch of candidates) {
      const res = await git.deleteMergedBranch(run.repoPath, branch, run.base);
      if (res && res.ok) out.deleted.push(branch);
      else if (!res || res.error !== 'missing') out.kept.push({ branch, reason: (res && res.error) || 'failed' });
    }
  } catch (err) {
    return { ...out, ok: false, error: errMessage(err) };
  }
  return out;
}

/**
 * The start-up sweep's record of a run whose merge landed (its ledger entry).
 * @param {{planId:string, repoPath:string, base:string, integrationBranch?:string|null,
 *   packages:Array<{id:string, branch:string|null, merged:boolean, skipped:boolean}>}} ctx
 * @param {number} settledAt
 * @returns {object|null} null when the facts do not check out
 */
function settledRunOf(ctx, settledAt) {
  return normalizeSettledRun({ ...(ctx || {}), settledAt });
}

/**
 * A ledger entry read back from disk, checked field by field; null when it
 * cannot be swept safely.
 * @param {unknown} raw
 */
function normalizeSettledRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { planId, repoPath, base, integrationBranch, settledAt } = raw;
  if (typeof planId !== 'string' || !RUN_ID_RE.test(planId)) return null;
  if (typeof repoPath !== 'string' || !repoPath || !path.isAbsolute(repoPath)) return null;
  if (!isBase(base) || !Number.isFinite(settledAt)) return null;
  const packages = (Array.isArray(raw.packages) ? raw.packages : [])
    .slice(0, MAX_PACKAGES)
    .filter((p) => p && typeof p.id === 'string' && PKG_ID_RE.test(p.id))
    .map((p) => ({
      id: p.id,
      branch: typeof p.branch === 'string' && OWN_BRANCH_RE.test(p.branch) ? p.branch : null,
      merged: p.merged === true,
      skipped: p.skipped === true,
    }));
  return {
    planId,
    repoPath,
    base,
    integrationBranch: typeof integrationBranch === 'string' && OWN_BRANCH_RE.test(integrationBranch) ? integrationBranch : null,
    packages,
    settledAt,
  };
}

/**
 * The ledger with `entry` in it (a run already there is replaced), oldest
 * dropped past MAX_SETTLED_RUNS.
 * @param {unknown} list
 * @param {object|null} entry
 * @returns {object[]}
 */
function withSettledRun(list, entry) {
  const clean = (Array.isArray(list) ? list : []).map(normalizeSettledRun).filter(Boolean);
  if (!entry) return clean.slice(-MAX_SETTLED_RUNS);
  return [...clean.filter((r) => r.planId !== entry.planId), entry].slice(-MAX_SETTLED_RUNS);
}

/**
 * The one-time start-up sweep: every settled run older than `maxAgeMs`
 * whose repo is still a registered project gets cleanupMergedRun once and
 * leaves the ledger; younger runs wait for a later start. Runs for a repo
 * that is no longer registered are dropped without touching it.
 * @param {{runs:unknown, now:number, isKnownRepo:(repoPath:string)=>boolean,
 *   cleanup:(run:object)=>Promise<object>, maxAgeMs?:number}} args
 * @returns {Promise<{swept:Array<{planId:string, result:object}>, remaining:object[]}>}
 */
async function sweepSettledRuns({ runs, now, isKnownRepo, cleanup, maxAgeMs = SETTLED_SWEEP_AGE_MS }) {
  const swept = [];
  const remaining = [];
  for (const run of withSettledRun(runs, null)) {
    if (now - run.settledAt < maxAgeMs) {
      remaining.push(run);
      continue;
    }
    if (!isKnownRepo(run.repoPath)) continue;
    let result;
    try {
      result = await cleanup(run);
    } catch (err) {
      result = { ok: false, error: errMessage(err) };
    }
    swept.push({ planId: run.planId, result });
  }
  return { swept, remaining };
}

module.exports = {
  cleanupFailedLaunch,
  orphanBranches,
  sweepOrphanBranches,
  launchIdOf,
  cleanupMergedRun,
  branchPlan,
  settledRunOf,
  normalizeSettledRun,
  withSettledRun,
  sweepSettledRuns,
  SETTLED_SWEEP_AGE_MS,
  MAX_SETTLED_RUNS,
};
