// ============================================================================
// LunaCore - per-account usage reserve (Claude accounts)
// ----------------------------------------------------------------------------
// An account may carry optional caps that keep part of its subscription in
// reserve: `reserve: {fiveHour?: n, weekly?: n}`, each an integer 1-100 (the
// highest percent of that window LunaCore may use). E.g. {fiveHour: 50,
// weekly: 70} keeps that account at or below 5 h 50% and weekly 70%.
//
//   storage    on the account record in claude-accounts.local.json. A record
//              without `reserve` (an older PC, an older build) means "no cap";
//              a malformed field is dropped on load, never thrown.
//   input      Settings sends both fields; validateReserve() takes an integer
//              1-100, its digit string, or empty/null (= no cap). Anything
//              else is refused with 'badReserve' - main never trusts the
//              renderer.
//   effect     an account whose last usage reading is at or over a cap counts
//              as LIMITED until that window resets: reserveLimits() returns it
//              as a cooldown, which src/claudeaccounts.js merges into every
//              pick. So failover (markLimited, failoverActive, the per-tab
//              failover in src/claudefailover.js), the auto-pick of the
//              account new work runs on, and God Mode's "all accounts out"
//              check all skip it exactly as if it had hit the real limit.
//              No reading (no usage login, expired login) means no cap check:
//              an account is never blocked on data LunaCore does not have.
//   display    the Usage panel draws the cap as a marker on the account's bar
//              and dims the row once the cap is reached (reserveCapFor()).
// ============================================================================

'use strict';

const MIN_CAP = 1;
const MAX_CAP = 100;
/** A reached cap whose window has no readable reset: look again after this long. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;
/** Usage window id (src/usage.js claudeLimits) -> reserve field. */
const CAP_FIELDS = Object.freeze({ '5h': 'fiveHour', weekly: 'weekly' });
const FIELDS = Object.freeze(Object.values(CAP_FIELDS));
const DIGITS_RE = /^\d{1,3}$/;

const isCap = (n) => Number.isInteger(n) && n >= MIN_CAP && n <= MAX_CAP;

/**
 * One cap from untrusted input: null for "no cap", a number 1-100, or
 * undefined when the value is not acceptable.
 * @param {unknown} value
 * @returns {number|null|undefined}
 */
function parseCap(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (!DIGITS_RE.test(text)) return undefined;
    const n = Number(text);
    return isCap(n) ? n : undefined;
  }
  return isCap(value) ? value : undefined;
}

/**
 * Validates a reserve sent by the renderer. Both fields are optional.
 * @param {unknown} input
 * @returns {{ok:true, reserve:{fiveHour?:number, weekly?:number}}|{ok:false, error:'badReserve'}}
 */
function validateReserve(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!raw) return { ok: false, error: 'badReserve' };
  const reserve = {};
  for (const field of FIELDS) {
    const cap = parseCap(raw[field]);
    if (cap === undefined) return { ok: false, error: 'badReserve' };
    if (cap !== null) reserve[field] = cap;
  }
  return { ok: true, reserve };
}

/**
 * A stored reserve with only its valid caps, or null when none is left (an
 * old record without the field, or junk). Never throws.
 * @param {unknown} raw
 * @returns {{fiveHour?:number, weekly?:number}|null}
 */
function cleanReserve(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of FIELDS) {
    if (isCap(raw[field])) out[field] = raw[field];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The cap that applies to one usage limit of an account, or null.
 * @param {{fiveHour?:number, weekly?:number}|null|undefined} reserve
 * @param {{window?:string}|null|undefined} limit
 * @returns {number|null}
 */
function capFor(reserve, limit) {
  const field = limit && CAP_FIELDS[limit.window];
  const cap = field && reserve ? reserve[field] : undefined;
  return isCap(cap) ? cap : null;
}

/** Epoch ms of a limit's reset, or null when it has none readable. */
function resetMs(limit) {
  const at = typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * When the reserve stops holding the account back: the latest reset among the
 * windows at or over their cap, or null when no cap is reached. A window whose
 * reset already passed has started over, so its old reading no longer counts.
 * @param {{fiveHour?:number, weekly?:number}|null|undefined} reserve
 * @param {Array<{window?:string, percentUsed?:number, resetsAt?:string|null}>} limits
 * @param {number} now
 * @returns {number|null}
 */
function reserveUntil(reserve, limits, now) {
  if (!reserve || !Array.isArray(limits)) return null;
  let until = null;
  for (const limit of limits) {
    if (!limit || typeof limit.percentUsed !== 'number') continue;
    const cap = capFor(reserve, limit);
    if (cap === null || limit.percentUsed < cap) continue;
    const reset = resetMs(limit);
    if (reset !== null && reset <= now) continue;
    const at = reset === null ? now + UNKNOWN_RESET_MS : reset;
    until = until === null ? at : Math.max(until, at);
  }
  return until;
}

/**
 * Cooldowns caused by reached caps, in the shape src/claudeaccounts.js merges
 * into every pick: account id -> epoch ms. Accounts without a cap or without
 * a reading are left out.
 * @param {Array<{id:string, reserve?:object|null}>} accounts
 * @param {Map<string, Array<object>>|null|undefined} readings account id -> its last usage limits
 * @param {number} now
 * @returns {Record<string, number>}
 */
function reserveLimits(accounts, readings, now) {
  const out = {};
  if (!Array.isArray(accounts) || !readings || typeof readings.get !== 'function') return out;
  for (const account of accounts) {
    if (!account || !account.reserve) continue;
    const until = reserveUntil(account.reserve, readings.get(account.id), now);
    if (until !== null) out[account.id] = until;
  }
  return out;
}

module.exports = {
  validateReserve,
  cleanReserve,
  parseCap,
  capFor,
  reserveUntil,
  reserveLimits,
  CAP_FIELDS,
  MIN_CAP,
  MAX_CAP,
};
