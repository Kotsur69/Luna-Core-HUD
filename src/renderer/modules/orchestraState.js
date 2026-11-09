// ============================================================================
// LunaCore - God Mode board: which state label a package shows (pure)
// ----------------------------------------------------------------------------
// A finishing package waits in the process-wide verify queue
// (src/verifyQueue.js) before its verify starts; the board says "waiting to
// verify" then instead of "verifying + pushing". No DOM, no imports: node
// --test reads it directly.
// ============================================================================

'use strict';

/**
 * The i18n state key (orch.state.<key>) for one package of the plan view.
 * @param {{state:string, verifyPhase?:string|null}} pkg
 * @returns {string}
 */
export function pkgStateKey(pkg) {
  if (!pkg || typeof pkg.state !== 'string') return 'pending';
  if (pkg.state === 'finishing' && pkg.verifyPhase === 'queued') return 'waitingVerify';
  return pkg.state;
}

// Causes the recovery playbook (src/orchestraRecover.js) can ask about; each
// has an orch.recover.ask.<cause> text in pl and en. 'depsLocked' is an ask
// only (a depsMissing whose install hit a file LunaCore holds open).
export const RECOVER_ASK_CAUSES = [
  'depsMissing', 'depsLocked', 'secretFound', 'pushBlocked', 'branchTaken', 'network', 'auth',
  'verifyTimeout', 'verifyLoad', 'stepHung', 'usageLimit', 'wakeGit',
];

/**
 * The open ask of a package: the playbook's last 'ask' entry in its stall
 * history, unless a manual Retry came after it. Null when there is none.
 * @param {{stallHistory?:Array<{kind?:string, reason?:string}>}} pkg
 * @returns {null|{key:string, cause:string}}
 */
export function recoverAsk(pkg) {
  const history = pkg && Array.isArray(pkg.stallHistory) ? pkg.stallHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const e = history[i] || {};
    if (e.kind === 'retry') return null;
    if (e.kind === 'ask' && RECOVER_ASK_CAUSES.includes(e.reason)) return { key: `orch.recover.ask.${e.reason}`, cause: e.reason };
  }
  return null;
}
