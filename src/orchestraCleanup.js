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
// Every function resolves a typed result and never rejects.
// ============================================================================

'use strict';

// orchestra.js names a launch `${pkg.id}-${stamp}`, stamp = 5 base-36 chars.
const STAMP_RE = /^[0-9a-z]{5}$/;
const BRANCH_PREFIX = 'luna/';

const errMessage = (err) => (err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));

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

module.exports = { cleanupFailedLaunch, orphanBranches, sweepOrphanBranches, launchIdOf };
