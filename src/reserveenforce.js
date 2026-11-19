// ============================================================================
// LunaCore - reserve enforcer: a reached reserve cap stops running work
// ----------------------------------------------------------------------------
// An account's reserve (src/accountreserve.js) makes it count as limited for
// every PICK: new tabs, new God Mode workers and failover targets skip it.
// That alone never touched work already running on it - the limit handler
// (main's onUsageLimit) only fires when the CLI itself hits the real wall, so
// a tab or worker kept spending past the cap while the Usage panel showed the
// account greyed out.
//
// This closes that gap. A session that is mid-turn on an account at its
// reserve gets the same treatment as a real limit hit (onReserveHit, wired in
// src/main.js): move to another free account, else stop the turn and wait for
// the reset. It is checked
//   - after every usage reading pass (sweep), for sessions working right now
//   - at every turn start (onTurnStart), so a turn that begins on a reserved
//     account is stopped at once, not up to one reading pass later.
// An idle session is left alone: moving it would inject "continue" into a
// conversation nobody asked to go on. Its next turn start is checked instead.
//
// Pure - accounts, readings, sessions and the handler are injected.
// ============================================================================

'use strict';

const { reserveLimits } = require('./accountreserve');

const errText = (err) => (err && err.message) || String(err);

/**
 * The Esc that stops a turn makes Claude Code write a "[Request interrupted by
 * user]" entry, which the transcript watcher reads as a new turn start. The
 * first turn start this soon after an Esc stop is that echo, not a new turn.
 */
const ESC_ECHO_MS = 5000;

/**
 * @param {{
 *   accounts: () => Array<{id:string, reserve?:object|null}>,
 *   readings: () => Map<string, Array<object>>,
 *   sessions: () => Iterable<object>,
 *   isWorking: (session:object) => boolean,
 *   onReserveHit: (session:object, until:number) => void,
 *   now?: () => number,
 *   log?: (line:string) => void,
 * }} deps
 */
function createReserveEnforcer(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  /** session id -> epoch ms until which its next turn start is the Esc's echo. */
  const escEchoes = new Map();

  /** account id -> epoch ms the reserve holds it until; {} when unreadable. */
  function cooldowns(t) {
    try {
      return reserveLimits(deps.accounts(), deps.readings(), t);
    } catch (err) {
      log(`reserve enforcer: could not read accounts or usage (${errText(err)})`);
      return {};
    }
  }

  /** A live tab that runs on one of the stored Claude accounts. */
  const onAccount = (s) => Boolean(s && s.alive !== false && !s.readOnly && !s.ownBackend && s.accountId);

  /** Hands one session to the limit handler; false when it threw (logged). */
  function hit(session, until) {
    try {
      deps.onReserveHit(session, until);
      return true;
    } catch (err) {
      log(`reserve enforcer: stopping ${session.id} failed (${errText(err)})`);
      return false;
    }
  }

  /**
   * After a usage reading: every working session on an account past its
   * reserve is stopped. Returns how many were handed to the handler.
   * @returns {number}
   */
  function sweep() {
    const t = now();
    const held = cooldowns(t);
    if (Object.keys(held).length === 0) return 0;
    let stopped = 0;
    for (const session of deps.sessions()) {
      if (!onAccount(session)) continue;
      const until = held[session.accountId];
      if (!(until > t) || !deps.isWorking(session)) continue;
      if (hit(session, until)) stopped += 1;
    }
    return stopped;
  }

  /**
   * A turn just started on `session`: stop it when its account is at its
   * reserve. True when the session was handed to the handler.
   * @param {object} session
   * @returns {boolean}
   */
  function onTurnStart(session) {
    if (!onAccount(session)) return false;
    const t = now();
    const until = cooldowns(t)[session.accountId];
    if (!(until > t)) return false;
    return hit(session, until);
  }

  /** The handler just stopped `sessionId`'s turn with an Esc. */
  function noteEscStop(sessionId) {
    escEchoes.set(sessionId, now() + ESC_ECHO_MS);
  }

  /**
   * True once for the first turn start right after an Esc stop: that "turn" is
   * the interrupt entry, and the caller drops it so the tab stays stopped.
   * @param {string} sessionId
   * @returns {boolean}
   */
  function takeEscEcho(sessionId) {
    const until = escEchoes.get(sessionId);
    if (until === undefined) return false;
    escEchoes.delete(sessionId);
    return until > now();
  }

  return { sweep, onTurnStart, noteEscStop, takeEscEcho };
}

module.exports = { createReserveEnforcer, ESC_ECHO_MS };
