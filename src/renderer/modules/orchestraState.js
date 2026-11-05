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
