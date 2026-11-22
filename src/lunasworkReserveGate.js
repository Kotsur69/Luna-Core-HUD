// ============================================================================
// LunaCore - Luna's Work: the account reserve gate for headless steps
// ----------------------------------------------------------------------------
// An account reserve (src/accountreserve.js) makes an account count as limited
// for every pick, so a headless step's env normally lands on an account with
// room (claudeAccounts.authLayer -> active()). When EVERY account is out,
// though, active() still returns one - the one with the earliest reset - and
// a new `claude -p` step would start on an account past its reserve and spend
// past the cap.
//
// This gate closes that: before a Claude call is spawned, the account its env
// runs on (ACCOUNT_ENV, set by the account layer) is checked against the
// reserve. A held account answers the step with a usage limit whose resumeAt
// is the reserve window's reset - the same answer a real limit hit gives - so
// the run controller (src/lunaswork.js limited()) waits exactly until then.
//
//   no reserveUntil dep, no account in the env, a failed check: the call is
//   spawned as before (a failed check is logged). An account is never blocked
//   on data LunaCore does not have - the reserve module's own rule.
//
// A step already running when the cap is crossed is not stopped here.
// Pure - the reserve lookup and the clock are injected.
// ============================================================================

'use strict';

const { reserveLimits } = require('./accountreserve');
const { ACCOUNT_ENV } = require('./claudeaccounts');

const errText = (err) => (err && err.message) || String(err);

/**
 * When the reserve holds `accountId`: the reserve window's reset (epoch ms),
 * or null when it is not held (no cap, no reading, cap not reached, unknown
 * account). The dep main hands the Luna's Work wiring as `reserveUntil`.
 * @param {string} accountId
 * @param {Array<{id:string, reserve?:object|null}>} accounts
 * @param {Map<string, Array<object>>} readings account id -> its last usage limits
 * @param {number} now
 * @returns {number|null}
 */
function accountReserveUntil(accountId, accounts, readings, now) {
  if (typeof accountId !== 'string' || !accountId) return null;
  const until = reserveLimits(accounts, readings, now)[accountId];
  return Number.isFinite(until) && until > now ? until : null;
}

/**
 * The usage-limit answer for a call that would spawn on a reserve-held
 * account, or null when the call may run.
 * @param {object|null|undefined} env the env the call would spawn with
 * @param {((accountId:string)=>number|null)|undefined} reserveUntil
 * @param {{now:number, log?:(line:string)=>void}} opts
 * @returns {{error:'limit', detail:string, resumeAt:number}|null}
 */
function reserveHold(env, reserveUntil, { now, log }) {
  if (typeof reserveUntil !== 'function' || !env || typeof env !== 'object') return null;
  const accountId = env[ACCOUNT_ENV];
  if (typeof accountId !== 'string' || !accountId) return null;
  let until;
  try {
    until = reserveUntil(accountId);
  } catch (err) {
    if (typeof log === 'function') log(`[lunaswork] reserve check failed, the step runs unchecked: ${errText(err)}`);
    return null;
  }
  if (!Number.isFinite(until) || until <= now) return null;
  return {
    error: 'limit',
    detail: `the Claude account is at its usage reserve until ${new Date(until).toISOString()}`,
    resumeAt: until,
  };
}

module.exports = { accountReserveUntil, reserveHold };
