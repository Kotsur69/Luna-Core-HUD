// ============================================================================
// LunaCore - God Mode package card: its text lines (split out of orchestra.js)
// ----------------------------------------------------------------------------
// The localized lines a package card shows under its title - the error text,
// the progress line and the never-blocks ladder lines. Shared by the board
// (orchestra.js) and the live map's side panel (liveMapDetails.js), so both
// say the same thing about a package.
// ============================================================================

'use strict';

import { t } from './util.js';
import { pkgStateKey } from './orchestraState.js';

// Per-package launch errors that come straight from src/worktrees.js.
const WORKTREE_ERRORS = new Set(['badName', 'notRepo', 'noCommits', 'exists', 'gitFailed']);

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The localized text of a package error code. */
export function pkgErrorText(code) {
  return WORKTREE_ERRORS.has(code) ? t(`tabs.worktree.err.${code}`) : t(`orch.pkgerr.${code}`);
}

/** One line under the title: what the supervisor is doing with this package. */
export function progressText(pkg) {
  if (pkg.awaitingDeps) return t('orch.progress.awaitingDeps');
  if (pkg.state === 'pushed' && pkg.merged) return t('orch.progress.merged');
  if (pkg.state === 'pushed' && pkg.headSha) return t('orch.progress.pushed', { sha: pkg.headSha.slice(0, 7) });
  if (pkg.state === 'launched' && (pkg.nudges || pkg.verifyRounds)) {
    return t('orch.progress.running', { nudges: pkg.nudges, verify: pkg.verifyRounds });
  }
  if (pkg.state === 'launched' && pkg.startedAt) return t('orch.progress.since', { time: clock(pkg.startedAt) });
  return '';
}

/**
 * What the never-blocks ladder did or is doing with this package: automatic
 * relaunch / resume, gave up, or waiting on a dependency that gave up.
 * @param {object} pkg
 * @param {object[]} packages every package of the run (to name the blocker)
 * @returns {string[]}
 */
export function ladderLines(pkg, packages) {
  const out = [];
  if (pkg.blockedBy) {
    const blocker = (packages || []).find((p) => p.id === pkg.blockedBy);
    const reason = blocker && blocker.error ? pkgErrorText(blocker.error) : t(`orch.state.${pkgStateKey(blocker)}`);
    out.push(t('orch.progress.blockedBy', { id: pkg.blockedBy, reason }));
  }
  if (pkg.autoRetries && !pkg.terminal && pkg.state === 'failed') {
    out.push(t('orch.progress.autoRetry', { n: pkg.autoRetries }));
  }
  if (pkg.autoResumed) out.push(t('orch.progress.autoResumed'));
  // Q8 auto-split (free-planned runs): being split, replaced, or made by one.
  if (pkg.splitting) out.push(t('orch.progress.splitting'));
  if (Array.isArray(pkg.splitInto) && pkg.splitInto.length) out.push(t('orch.progress.splitInto', { ids: pkg.splitInto.join(', ') }));
  else if (pkg.terminal) out.push(t('orch.progress.terminal'));
  if (pkg.splitOf) out.push(t('orch.progress.splitOf', { id: pkg.splitOf }));
  return out;
}
