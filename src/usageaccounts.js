// ============================================================================
// LunaCore - per-account Claude usage (docs/CLAUDE_ACCOUNTS_PLAN.md Phase 2)
// ----------------------------------------------------------------------------
// The usage meter for every Claude account set up in Settings, not only the
// /login one src/usage.js reads from ~/.claude/.credentials.json. MAIN
// PROCESS ONLY: tokens come from claudeAccounts.usageCredentials() and never
// leave this module - the renderer gets labels, percentages and reset times.
//
// HOW AN ACCOUNT IS READ (the P0 probe decides, once per app run):
//   'usage'    GET /api/oauth/usage accepts a setup-token -> each account is
//              polled like today's meter (zero quota).
//   'headers'  it answers 401/403 (setup-tokens are expected to be
//              inference-only) -> the anthropic-ratelimit-unified-* response
//              headers are read instead: the free count_tokens call first;
//              when that carries none, a 1-token Haiku call at most every
//              15 min, and only for accounts that are NOT active (the active
//              one is spent by the work anyway; its row keeps its last reading).
// The probe asks the active account, and a second one when the first is
// refused, so one revoked token does not decide for all of them. An account
// that 401/403s while the mode is 'usage' is read through headers. A probe
// with no clear answer (network, 429, 5xx) is tried again after its backoff.
//
// COOLDOWN SYNC: a WALL (utilization >= 100 on the usage endpoint, a
// 'rejected' status in the headers) puts the account on cooldown until that
// window's REAL reset - replacing the hour claudeaccounts guesses when the CLI
// gave none, but never shortening a longer cooldown (it may be a wall this
// meter cannot see: an Opus window, overage). Only a cooldown this meter set
// is ended by a reading back under 90 % (the window reset early); one the CLI
// set runs to its own time. main.js turns both into claudeAccounts + God Mode
// registry calls (deps.onLimit / deps.onClear).
//
// NEVER log or return a token. Logs carry status codes and account labels.
// ============================================================================

'use strict';

const https = require('https');
const { parseRetryAfter } = require('./usage');
const { UNKNOWN_RESET_MS } = require('./claudeaccounts');

const HOST = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';
/** The cheapest current model for the 1-token header read. */
const PROBE_MODEL = 'claude-haiku-5-5';
/** Subscription OAuth tokens are issued for Claude Code requests. */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Socket idle timeout, and the hard limit for the whole request. */
const REQUEST_IDLE_MS = 8000;
const REQUEST_DEADLINE_MS = 10000;
const MAX_BODY_CHARS = 64 * 1024;

/** Per-account cadence: the usage endpoint, the free header read, the paid one. */
const USAGE_EVERY_MS = 2 * 60 * 1000;
const HEADERS_EVERY_MS = 5 * 60 * 1000;
const MESSAGE_EVERY_MS = 15 * 60 * 1000;
const RATE_LIMITED_WAIT_MS = 5 * 60 * 1000;
/** A reading older than this no longer stands in for the active account. */
const STALE_MS = 20 * 60 * 1000;

/** The wall; every window under CLEAR_BELOW_PCT means the window has reset. */
const LIMIT_PCT = 100;
const CLEAR_BELOW_PCT = 90;
/** Two reset times this close are the same reset (no cooldown rewrite). */
const SAME_RESET_MS = 60 * 1000;

/** The windows the meter shows, in order. */
const WINDOWS = ['5h', 'weekly'];
/** Extra /api/oauth/usage windows: not shown, but a wall there is a wall. */
const EXTRA_USAGE_KEYS = ['seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];
const UNIFIED = 'anthropic-ratelimit-unified-';
const RATE_LIMITED = 'status 429';

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** An ISO time from an ISO / epoch-seconds / epoch-ms value, or null. */
function isoOrNull(value) {
  const raw = first(value);
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(raw));
  return isTime(ms) ? new Date(ms).toISOString() : null;
}

// ---- parsing ---------------------------------------------------------------------
// A window is {pct, resetsAt, wall}: pct for the bar (rounded), wall decided
// on the unrounded value or an explicit rejection - 99.6 % is not the wall.

/** One /api/oauth/usage window ({utilization: percent, resets_at: ISO}), or null. */
function usageWindow(w) {
  if (!w || typeof w !== 'object' || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return { pct: clampPct(w.utilization), resetsAt: isoOrNull(w.resets_at), wall: w.utilization >= LIMIT_PCT };
}

/**
 * The /api/oauth/usage body -> {windows: {'5h', weekly}, extra}, or null when
 * it is not JSON or has neither shown window.
 * @param {string} body
 */
function parseUsageBody(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const windows = { '5h': usageWindow(data.five_hour), weekly: usageWindow(data.seven_day) };
  if (!windows['5h'] && !windows.weekly) return null;
  return { windows, extra: EXTRA_USAGE_KEYS.map((k) => usageWindow(data[k])).filter(Boolean) };
}

/**
 * Utilization from a header, for the bar only. Taken as a 0..1 fraction
 * (Claude Code shows it as a percent); a value above 1 is read as a percent
 * already. Unverified live - see the plan doc - which is why the WALL in
 * headers mode is the 'rejected' status, never this number.
 */
function headerPct(value) {
  const n = parseFloat(first(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return clampPct(n <= 1 ? n * 100 : n);
}

function headerWindow(headers, key) {
  const pct = headerPct(headers[`${UNIFIED}${key}-utilization`]);
  const rejected = first(headers[`${UNIFIED}${key}-status`]) === 'rejected';
  if (pct === null && !rejected) return null;
  return { pct: rejected ? LIMIT_PCT : pct, resetsAt: isoOrNull(headers[`${UNIFIED}${key}-reset`]), wall: rejected };
}

/**
 * anthropic-ratelimit-unified-* headers (Node lower-cases them) ->
 * {windows, extra}, or null when none are there. An overall 'rejected'
 * counts as a wall until the overall reset, whichever window it was.
 * @param {Record<string, string|string[]>} headers
 */
function parseUnifiedHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const windows = { '5h': headerWindow(headers, '5h'), weekly: headerWindow(headers, '7d') };
  const overall = first(headers[`${UNIFIED}status`]);
  if (!windows['5h'] && !windows.weekly && typeof overall !== 'string') return null;
  const extra = overall === 'rejected'
    ? [{ pct: LIMIT_PCT, resetsAt: isoOrNull(headers[`${UNIFIED}reset`]), wall: true }]
    : [];
  return { windows, extra };
}

// ---- decisions (pure) ---------------------------------------------------------------

/**
 * What one fresh reading means for the account's failover cooldown.
 *   limit  a wall with a known reset that differs from the cooldown - set it,
 *          unless that would SHORTEN a cooldown longer than claudeaccounts'
 *          one-hour guess (a wall this reading cannot see)
 *   adopt  at the wall and the cooldown already ends at that reset
 *   clear  every window under 90 % and the cooldown is the one this meter
 *          set (`ownedUntil`) - a cooldown the CLI set runs to its own time
 * @param {{windows:object, extra:Array}} reading
 * @param {number|null} limitedUntil the account's current cooldown
 * @param {number} now
 * @param {number|null} [ownedUntil] the cooldown this meter last set or adopted
 * @returns {null|{type:'limit'|'adopt', until:number}|{type:'clear'}}
 */
function cooldownAction(reading, limitedUntil, now, ownedUntil = null) {
  const all = [...WINDOWS.map((k) => reading.windows[k]), ...reading.extra].filter(Boolean);
  if (!all.length) return null;
  const cooling = isTime(limitedUntil) && limitedUntil > now;
  const walls = all.filter((w) => w.wall === true);
  if (walls.length) {
    const resets = walls.map((w) => Date.parse(w.resetsAt)).filter((t) => Number.isFinite(t) && t > now);
    // At the wall with no reset to go by: the CLI's own cooldown stands.
    if (!resets.length) return null;
    const until = Math.max(...resets);
    if (cooling && Math.abs(limitedUntil - until) < SAME_RESET_MS) return { type: 'adopt', until: limitedUntil };
    if (cooling && limitedUntil > until && limitedUntil - now > UNKNOWN_RESET_MS + SAME_RESET_MS) return null;
    return { type: 'limit', until };
  }
  const ours = cooling && isTime(ownedUntil) && Math.abs(limitedUntil - ownedUntil) < SAME_RESET_MS;
  return ours && all.every((w) => w.pct < CLEAR_BELOW_PCT) ? { type: 'clear' } : null;
}

/** The shown window with the account's highest use (the one a cooldown is about). */
function topWindow(reading) {
  let best = null;
  for (const key of WINDOWS) {
    const w = reading.windows[key];
    if (w && (!best || w.pct > reading.windows[best].pct)) best = key;
  }
  return best;
}

/**
 * The meter's rows, grouped by window: the active account first, then the
 * rest in preference order. `limited` (reset in full colour) is a window at
 * the wall or - while the account cools down - its fullest one. An account
 * without a reading yet still gets its row (pct null).
 * @param {Array<{id:string, label:string, active:boolean, limitedUntil:number|null}>} accounts preference order
 * @param {Record<string, {windows:object, at:number}>} readings
 * @param {number} now
 */
function groupAccountUsage(accounts, readings, now) {
  const ordered = [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)];
  return WINDOWS.map((key) => ({
    window: key,
    rows: ordered.map((a) => {
      const reading = readings[a.id] || null;
      const w = reading ? reading.windows[key] : null;
      const cooling = isTime(a.limitedUntil) && a.limitedUntil > now;
      return {
        id: a.id,
        label: a.label,
        active: a.active === true,
        pct: w ? w.pct : null,
        resetsAt: w ? w.resetsAt : null,
        limited: Boolean(w) && (w.wall === true || (cooling && topWindow(reading) === key)),
      };
    }),
  }));
}

/**
 * What the renderer gets (no tokens). Null with no accounts or no reading
 * yet - the meter then stays exactly as today.
 */
function accountUsageView(accounts, readings, mode, now) {
  const read = accounts.map((a) => readings[a.id]).filter(Boolean);
  if (!read.length) return null;
  return { mode, updatedAt: Math.max(...read.map((r) => r.at)), groups: groupAccountUsage(accounts, readings, now) };
}

/** usage.js limit entries (the shape ClaudeAdapter builds) from a reading. */
function limitsFrom(windows) {
  const out = [];
  const five = windows['5h'];
  const week = windows.weekly;
  if (five) {
    out.push({ window: '5h', label: '5-hour window', unit: 'messages', used: five.pct * 10, limit: 1000, percentUsed: five.pct, resetsAt: five.resetsAt, source: 'account' });
  }
  if (week) {
    out.push({ window: 'weekly', label: 'Weekly limit', unit: 'messages', used: week.pct * 70, limit: 7000, percentUsed: week.pct, resetsAt: week.resetsAt, source: 'account' });
  }
  return out;
}

/**
 * The primary usage read with the ACTIVE account's numbers in it, so the
 * voice alerts, the phone snapshot and God Mode's reset reads follow the
 * account the work runs on. Unchanged without a fresh reading of it, or
 * while the active tab's provider is not Claude.
 */
function withActiveAccount(primary, accounts, readings, now) {
  const active = accounts.find((a) => a.active);
  const reading = active ? readings[active.id] : null;
  if (!reading || now - reading.at > STALE_MS) return primary;
  if (primary && primary.providerId && primary.providerId !== 'claude') return primary;
  const limits = limitsFrom(reading.windows);
  if (!limits.length) return primary;
  return {
    ...(primary || {}),
    providerId: 'claude',
    displayName: (primary && primary.displayName) || 'Claude',
    status: 'ok',
    errorMessage: null,
    limits,
    isFallback: false,
    updatedAt: reading.at,
    accountId: active.id,
  };
}

// ---- network ------------------------------------------------------------------------

/**
 * One HTTPS call to api.anthropic.com with a setup-token. Always settles,
 * exactly once: {status: 0} on a network error, a reset mid-body, an idle
 * socket or the hard deadline - a hung read must never freeze the meter.
 * The token goes into the Authorization header only - never logged or returned.
 * @param {{method:'GET'|'POST', path:string, token:string, body?:object}} req
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
function requestAnthropic({ method, path, token, body }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(out);
    };
    const fail = () => {
      if (settled) return;
      if (req) req.destroy();
      finish({ status: 0, headers: {}, body: '' });
    };
    const deadline = setTimeout(fail, REQUEST_DEADLINE_MS);
    if (typeof deadline.unref === 'function') deadline.unref();
    const payload = body ? JSON.stringify(body) : null;
    try {
      req = https.request(
        {
          method,
          host: HOST,
          path,
          timeout: REQUEST_IDLE_MS,
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': OAUTH_BETA,
            'anthropic-version': API_VERSION,
            Accept: 'application/json',
            'User-Agent': 'LunaCore/0.1 (usage-meter)',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', (chunk) => {
            if (text.length < MAX_BODY_CHARS) text += chunk;
          });
          res.on('end', () => finish({ status: res.statusCode || 0, headers: res.headers || {}, body: text }));
          res.on('error', fail);
          res.on('aborted', fail);
          // After 'end' this is a no-op; without it the body never completed.
          res.on('close', fail);
        },
      );
      req.on('error', fail);
      req.on('timeout', fail);
      if (payload) req.write(payload);
      req.end();
    } catch {
      fail();
    }
  });
}

const ONE_MESSAGE = [{ role: 'user', content: '.' }];
const COUNT_BODY = { model: PROBE_MODEL, system: CLAUDE_CODE_SYSTEM, messages: ONE_MESSAGE };
const MESSAGE_BODY = {
  model: PROBE_MODEL,
  max_tokens: 1,
  thinking: { type: 'disabled' },
  system: CLAUDE_CODE_SYSTEM,
  messages: ONE_MESSAGE,
};

const waitAfter429 = (headers) => parseRetryAfter(headers && headers['retry-after']) || RATE_LIMITED_WAIT_MS;

// ---- the poller ---------------------------------------------------------------------

/**
 * @param {{
 *   credentials: () => Array<{id:string, label:string, token:string}>,
 *   accounts: () => Array<{id:string, label:string, active:boolean, limitedUntil:number|null}>,
 *   onLimit: (id:string, until:number) => void,
 *   onClear: (id:string) => void,
 *   request?: typeof requestAnthropic,
 *   now?: () => number,
 *   log?: (line:string) => void,
 * }} deps credentials: main only (claudeAccounts.usageCredentials);
 *   accounts: claudeAccounts.list().accounts (no tokens), preference order
 */
function createAccountUsage(deps) {
  const request = deps.request || requestAnthropic;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  /** @type {null|'usage'|'headers'} null until the probe gets a clear answer */
  let mode = null;
  /** @type {Record<string, {windows:object, extra:Array, at:number}>} */
  let readings = {};
  let nextAt = {}; // id -> the earliest next read
  let messageAt = {}; // id -> the last paid 1-token read
  let viaHeaders = {}; // id -> true once /api/oauth/usage refused that account
  let owned = {}; // id -> the cooldown this meter set or adopted
  let lastFailure = {}; // id -> the last failure (logged on change only)
  // null: unknown; false: count_tokens answered 200 without the unified headers.
  let countHasHeaders = null;
  let running = null;

  const setKey = (obj, id, value) => ({ ...obj, [id]: value });
  const dropKey = (obj, id) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== id));

  function listAccounts() {
    try {
      return deps.accounts();
    } catch {
      return [];
    }
  }

  async function readUsage(cred) {
    const res = await request({ method: 'GET', path: '/api/oauth/usage', token: cred.token });
    if (res.status === 200) {
      const reading = parseUsageBody(res.body);
      return reading ? { reading, wait: USAGE_EVERY_MS } : { failure: 'unparsable', wait: USAGE_EVERY_MS };
    }
    if (res.status === 401 || res.status === 403) return { refused: true };
    if (res.status === 429) return { failure: RATE_LIMITED, wait: waitAfter429(res.headers) };
    return { failure: `status ${res.status}`, wait: USAGE_EVERY_MS };
  }

  /** count_tokens first; then - for a non-active account only - the 1-token call. */
  async function readHeaders(cred, isActive) {
    if (countHasHeaders !== false) {
      const res = await request({ method: 'POST', path: '/v1/messages/count_tokens', token: cred.token, body: COUNT_BODY });
      const reading = parseUnifiedHeaders(res.headers);
      if (reading) {
        countHasHeaders = true;
        return { reading, wait: HEADERS_EVERY_MS };
      }
      if (res.status === 429) return { failure: RATE_LIMITED, wait: waitAfter429(res.headers) };
      if (res.status === 0 || res.status >= 500) return { failure: `status ${res.status}`, wait: HEADERS_EVERY_MS };
      // A clean 200 without the headers settles it for this run; any other
      // answer (a bad token, a refused model) goes to the paid read this time only.
      if (res.status === 200 && countHasHeaders === null) {
        countHasHeaders = false;
        log('count_tokens carries no rate-limit headers - using the 1-token read');
      }
    }
    // The active account is never spent on a probe.
    if (isActive) return { wait: HEADERS_EVERY_MS };
    const since = now() - (messageAt[cred.id] || 0);
    if (since < MESSAGE_EVERY_MS) return { wait: MESSAGE_EVERY_MS - since };
    messageAt = setKey(messageAt, cred.id, now());
    const res = await request({ method: 'POST', path: '/v1/messages', token: cred.token, body: MESSAGE_BODY });
    // A 429 at the wall carries the headers too - that IS the reading.
    const reading = parseUnifiedHeaders(res.headers);
    if (reading) return { reading, wait: MESSAGE_EVERY_MS };
    return { failure: `status ${res.status}`, wait: res.status === 429 ? waitAfter429(res.headers) : MESSAGE_EVERY_MS };
  }

  async function readAccount(cred, isActive) {
    if (mode === 'usage' && !viaHeaders[cred.id]) {
      const out = await readUsage(cred);
      if (!out.refused) return out;
      viaHeaders = setKey(viaHeaders, cred.id, true);
      log(`"${cred.label}": /api/oauth/usage refused (401/403) - reading its rate-limit headers`);
    }
    return readHeaders(cred, isActive);
  }

  function syncCooldown(id, reading) {
    // Read the cooldown NOW, not at the start of the pass: the CLI may have
    // set one while this read was in flight.
    const account = listAccounts().find((a) => a.id === id);
    const action = cooldownAction(reading, account ? account.limitedUntil : null, now(), owned[id] || null);
    if (!action) return;
    try {
      if (action.type === 'limit') deps.onLimit(id, action.until);
      if (action.type === 'clear') deps.onClear(id);
      owned = action.type === 'clear' ? dropKey(owned, id) : setKey(owned, id, action.until);
    } catch (err) {
      log(`cooldown sync failed: ${errText(err)}`);
    }
  }

  /** @returns {boolean} a new reading arrived */
  function record(cred, out) {
    nextAt = setKey(nextAt, cred.id, now() + (typeof out.wait === 'number' ? out.wait : USAGE_EVERY_MS));
    const failure = out.failure || null;
    if (failure && failure !== lastFailure[cred.id]) log(`"${cred.label}": usage read failed (${failure})`);
    lastFailure = setKey(lastFailure, cred.id, failure);
    if (!out.reading) return false;
    readings = setKey(readings, cred.id, { ...out.reading, at: now() });
    syncCooldown(cred.id, out.reading);
    return true;
  }

  /** One account, never throwing: a throw is a failure with the normal wait. */
  async function readSafely(read, cred) {
    try {
      return await read();
    } catch (err) {
      return { failure: `error ${errText(err)}`, wait: USAGE_EVERY_MS };
    }
  }

  /**
   * P0: /api/oauth/usage on the active account - and on one more when the
   * first is refused - decides the mode for this app run.
   */
  async function probe(creds, activeId) {
    const ordered = [...creds.filter((c) => c.id === activeId), ...creds.filter((c) => c.id !== activeId)].slice(0, 2);
    if ((nextAt[ordered[0].id] || 0) > now()) return false;
    let changed = false;
    let refusedId = null;
    for (const cred of ordered) {
      const out = await readSafely(() => readUsage(cred), cred);
      if (out.reading) {
        mode = 'usage';
        if (refusedId) viaHeaders = setKey(viaHeaders, refusedId, true);
        log('probe: /api/oauth/usage answers a setup-token - polling it per account');
        return record(cred, out) || changed;
      }
      if (!out.refused) {
        changed = record(cred, out) || changed;
        if (!refusedId) log(`probe: no clear answer (${out.failure}) - trying again later`);
        break;
      }
      refusedId = refusedId || cred.id;
    }
    if (refusedId) {
      mode = 'headers';
      log('probe: /api/oauth/usage refused a setup-token (401/403) - reading rate-limit headers');
    }
    return changed;
  }

  async function runTick() {
    let creds;
    let accounts;
    try {
      creds = deps.credentials();
      accounts = deps.accounts();
    } catch (err) {
      log(`accounts unreadable: ${errText(err)}`);
      return false;
    }
    const ids = new Set(creds.map((c) => c.id));
    // A removed account's row goes with it.
    readings = Object.fromEntries(Object.entries(readings).filter(([id]) => ids.has(id)));
    if (!creds.length) return false;
    const activeId = (accounts.find((a) => a.active) || {}).id || null;
    let changed = false;
    if (mode === null) {
      changed = await probe(creds, activeId);
      if (mode === null) return changed;
    }
    for (const cred of creds) {
      if ((nextAt[cred.id] || 0) > now()) continue;
      changed = record(cred, await readSafely(() => readAccount(cred, cred.id === activeId), cred)) || changed;
    }
    return changed;
  }

  /** One pass over the accounts that are due. Never rejects; one pass at a time. */
  function tick() {
    if (!running) {
      running = runTick()
        .catch((err) => {
          log(`tick failed: ${errText(err)}`);
          return false;
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  /**
   * The refresh button: every account is due again - except one waiting out
   * a 429 (pressing the button must not hammer a rate-limited endpoint). The
   * paid read keeps its 15 min either way.
   */
  function refresh() {
    nextAt = Object.fromEntries(Object.entries(nextAt).filter(([id]) => lastFailure[id] === RATE_LIMITED));
    return tick();
  }

  /**
   * The watcher payload: the active account's numbers in `limits` and the
   * grouped rows in `accounts` - always present (null = no accounts / no
   * reading, the meter as today), so the renderer can tell it from a
   * payload that never had the field.
   */
  function applyTo(primary) {
    const accounts = listAccounts();
    const t = now();
    return { ...withActiveAccount(primary, accounts, readings, t), accounts: accountUsageView(accounts, readings, mode, t) };
  }

  return { tick, refresh, applyTo, mode: () => mode };
}

module.exports = {
  createAccountUsage,
  parseUsageBody,
  parseUnifiedHeaders,
  cooldownAction,
  groupAccountUsage,
  accountUsageView,
  withActiveAccount,
  limitsFrom,
  requestAnthropic,
  COUNT_BODY,
  MESSAGE_BODY,
  constants: {
    USAGE_EVERY_MS,
    HEADERS_EVERY_MS,
    MESSAGE_EVERY_MS,
    RATE_LIMITED_WAIT_MS,
    STALE_MS,
    LIMIT_PCT,
    CLEAR_BELOW_PCT,
    PROBE_MODEL,
  },
};
