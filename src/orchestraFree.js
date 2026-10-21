// ============================================================================
// LunaCore - God Mode "free providers" mode (pure rules)
// ----------------------------------------------------------------------------
// A free run is a normal God Mode run with three things pinned:
//
//   - workers   run on a free-model chain profile (src/freechains.js), so a
//               model that hits its limit hands the work to the next one;
//   - branches  every package works on `luna-free/<slug>` and ALWAYS commits
//               and pushes there - even after a failed verify, so the work of
//               a weaker free model is never lost (the worker still gets the
//               failure to fix);
//   - target    the run's integration is fixed to 'branches': nothing is
//               merged into, or opened against, the normal target branch.
//
// orchestra.js applies these; worktrees.js / orchestraFinish.js do the git.
// ============================================================================

'use strict';

const { resolveProfileChain } = require('./freechains');

const FREE_BRANCH_PREFIX = 'luna-free/';
const FREE_INTEGRATION = 'branches';
/** Branches a free run may never push to, whatever the base is called. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

/** The branch a free package works on, from its worktree slug. */
function freeBranchName(slug) {
  return `${FREE_BRANCH_PREFIX}${slug}`;
}

/**
 * True when `branch` is a free-run branch that is not the target branch.
 * @param {string} branch
 * @param {string|null} baseBranch the run's normal target branch
 */
function isSafeFreeBranch(branch, baseBranch) {
  if (typeof branch !== 'string' || !branch.startsWith(FREE_BRANCH_PREFIX)) return false;
  const tail = branch.slice(FREE_BRANCH_PREFIX.length);
  if (!tail || tail.includes('..')) return false;
  return branch !== baseBranch && !PROTECTED_BRANCHES.has(branch);
}

/**
 * The profile free workers run on: the one Mati picked if it has a chain,
 * else the first profile that has one. Null = no free profile configured.
 * @param {object[]} profiles
 * @param {object[]} providers
 * @param {object[]} chains
 * @param {string|null} [preferredId]
 * @returns {string|null}
 */
function pickFreeProfileId(profiles, providers, chains, preferredId = null) {
  const list = Array.isArray(profiles) ? profiles : [];
  const hasChain = (p) => !!resolveProfileChain(p, providers, chains);
  const preferred = preferredId ? list.find((p) => p && p.id === preferredId) : null;
  if (preferred && hasChain(preferred)) return preferred.id;
  const first = list.find((p) => p && hasChain(p));
  return first ? first.id : null;
}

/**
 * What Approve with "free providers" turns the run into.
 * @param {{freeProfileId:string|null}} input
 * @returns {{ok:true, profileId:string, integrationMode:string, branchPrefix:string}|{ok:false, error:'noFreeProfile'}}
 */
function freeRunSettings({ freeProfileId }) {
  if (!freeProfileId) return { ok: false, error: 'noFreeProfile' };
  return { ok: true, profileId: freeProfileId, integrationMode: FREE_INTEGRATION, branchPrefix: FREE_BRANCH_PREFIX };
}

/** A free run's integration can never change away from 'branches'. */
function integrationFor(plan, requested) {
  return plan && plan.freeMode ? FREE_INTEGRATION : requested;
}

module.exports = {
  FREE_BRANCH_PREFIX,
  FREE_INTEGRATION,
  freeBranchName,
  isSafeFreeBranch,
  pickFreeProfileId,
  freeRunSettings,
  integrationFor,
};
