// ============================================================================
// LunaCore - per-tab Claude account failover
// ----------------------------------------------------------------------------
// When the account a tab's `claude` runs on hits its usage limit, the tab is
// restarted on the next free account (src/claudeaccounts.js) with `--resume`
// of the same conversation plus a "continue" message (src/launch.js
// withAccountResume). Everything process-bound (the profile list, the session
// map, restarting a PTY, the IPC send) is injected, so this runs - and is
// tested - without Electron. src/main.js only wires it.
// ============================================================================

'use strict';

/** One tab moves accounts at most this often (a loop guard). */
const TAB_FAILOVER_MIN_GAP_MS = 60 * 1000;

/** The terminal line shown when a tab continues on another account. */
function accountSwitchNotice(from, to, lang) {
  const text = lang === 'pl'
    ? `[LunaCore] Limit na koncie ${from}. Kontynuuje na koncie ${to}.`
    : `[LunaCore] Usage limit on ${from}. Continuing on ${to}.`;
  return `\x1b[2;33m${text}\x1b[0m\r\n`;
}

/**
 * @param {{
 *   accounts: {markLimited:Function, freeAccount:Function},
 *   getProfile: (profileId:string) => ({command?:string, args?:string[]}|null|undefined),
 *   withAccountResume: (command:string, uuid:string, task?:object|null) => string|null,
 *   restartSession: (session:object) => void,
 *   send: (channel:string, payload:object) => void,
 *   isCurrent?: (session:object) => boolean,
 *   lang?: () => string|undefined,
 *   now?: () => number,
 *   defer?: (fn:() => void) => void,
 * }} deps
 */
function createTabFailover(deps) {
  const now = deps.now || Date.now;
  const lang = deps.lang || (() => 'en');
  const isCurrent = deps.isCurrent || (() => true);
  const defer = deps.defer || setImmediate;

  /**
   * Account failover for one tab. Marks the tab's account as cooling down and,
   * when another account is free, restarts the tab on it with `--resume` of
   * the same conversation plus "continue". A tab started before accounts were
   * set up (accountId null, plain Claude) moves to the free account straight
   * away. False: nothing switched, the caller waits the limit out as before.
   * @param {object} session
   * @param {number|null} resetsAt
   * @returns {boolean}
   */
  function failoverTab(session, resetsAt) {
    if (session.readOnly || session.ownBackend || !session.transcriptId) return false;
    const t = now();
    // The same account failing twice in a row this fast means the switch did not
    // help (e.g. a resume that cannot start) - stop and wait instead of looping.
    const sameAccount = session.lastFailoverFrom === (session.accountId || null);
    if (sameAccount && session.lastFailoverAt && t - session.lastFailoverAt < TAB_FAILOVER_MIN_GAP_MS) return false;
    const profile = deps.getProfile(session.profileId);
    const base = profile ? [profile.command, ...(profile.args || [])].join(' ').trim() : '';
    if (!deps.withAccountResume(base, session.transcriptId, session.launchTask || null)) return false;
    const res = session.accountId
      ? deps.accounts.markLimited(session.accountId, resetsAt)
      : { from: { label: 'default login' }, switchTo: deps.accounts.freeAccount() };
    if (!res.switchTo) return false;
    session.lastFailoverAt = t;
    session.lastFailoverFrom = session.accountId || null;
    session.resumeId = session.transcriptId;
    const notice = accountSwitchNotice(res.from.label, res.switchTo.label, lang());
    // Deferred: this runs inside the transcript watcher's read, which the
    // restart stops.
    defer(() => {
      if (!isCurrent(session)) return;
      deps.restartSession(session);
      deps.send('pty:data', { sessionId: session.id, data: notice });
    });
    return true;
  }

  return { failoverTab };
}

module.exports = { createTabFailover, accountSwitchNotice, TAB_FAILOVER_MIN_GAP_MS };
