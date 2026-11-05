// ============================================================================
// LunaCore - Claude account failover (several subscriptions, one harness)
// ----------------------------------------------------------------------------
// Mati has more than one Claude subscription. When the account a `claude`
// runs on hits its 5 h or weekly limit, LunaCore moves the work to the next
// account instead of waiting for the reset.
//
// HOW AN ACCOUNT IS SELECTED: `claude setup-token` mints a long-lived OAuth
// token per account. The CLI honours CLAUDE_CODE_OAUTH_TOKEN over the stored
// /login (verified live on 2.1.316: `auth status` reports
// authMethod "oauth_token"), per process, while CLAUDE_CONFIG_DIR stays
// ~/.claude - so every account runs the SAME harness (skills, rules, hooks,
// plugins, memory). Nothing in ~/.claude is copied, swapped or trimmed.
//
//   accounts   ordered list; the first one that is not cooling down is active
//   limits     account id -> epoch ms its limit resets (a cooldown)
//
// The env layer (authLayerFor) is skipped for any env that already chose its
// own backend (a z.ai / LM Studio / CCR profile, an API key, an explicit
// token): only plain Claude-subscription launches are steered.
//
// Storage: one safeStorage-encrypted file (claude-accounts.local.json, same
// pattern as cloudauth.js). No encryption available -> nothing is written;
// a plaintext token never touches disk. The file is re-read when its mtime
// changes, so the HUD and a host-mode process stay in step.
// ============================================================================

'use strict';

const fs = require('fs');

const VERSION = 1;
/** Env keys that mean "this launch already picked its backend / credentials". */
const BACKEND_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];
/** Marker env key: which account a process was started on (never a secret). */
const ACCOUNT_ENV = 'LUNACORE_CLAUDE_ACCOUNT';
/** `claude setup-token` output shape. */
const TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/;
const TOKEN_IN_TEXT_RE = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;
const ID_RE = /^[a-z0-9]{1,20}$/;
const MAX_ACCOUNTS = 8;
const MAX_LABEL = 60;
/** Limit with no readable reset time: look again after this long. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

/**
 * A token from pasted text: whitespace and line breaks removed (a token copied
 * out of a wrapped terminal line comes back split). Null when none found.
 * @param {unknown} text
 * @returns {string|null}
 */
function extractToken(text) {
  if (typeof text !== 'string') return null;
  const m = TOKEN_IN_TEXT_RE.exec(text.replace(/\s+/g, ''));
  return m ? m[0] : null;
}

/** True when `token` looks like a setup-token OAuth token. */
const isValidToken = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/**
 * The account to run on: the first one whose cooldown is over. When every
 * account is cooling down, the one that resets soonest (the wait is shortest
 * there). Null when there are no accounts.
 * @param {{id:string}[]} accounts
 * @param {Record<string,number>} limits
 * @param {number} now
 * @returns {object|null}
 */
function pickActive(accounts, limits, now) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const until = (a) => (Number.isFinite(limits[a.id]) ? limits[a.id] : 0);
  const free = accounts.find((a) => until(a) <= now);
  if (free) return free;
  return accounts.reduce((best, a) => (until(a) < until(best) ? a : best));
}

/**
 * The env keys that put one launch on `account`, or {} when the launch must be
 * left alone (no account, or the env already chose its own backend).
 * @param {Record<string,string>} env merged env of the launch
 * @param {{id:string, token:string}|null} account
 * @returns {Record<string,string>}
 */
function authLayerFor(env, account) {
  if (!account || !isValidToken(account.token)) return {};
  if (usesOwnBackend(env)) return {};
  return { CLAUDE_CODE_OAUTH_TOKEN: account.token, [ACCOUNT_ENV]: account.id };
}

/**
 * True when an env already chose its backend or credentials (a provider
 * profile, an API key, an explicit token) - account failover stays out.
 * @param {Record<string,string>|null|undefined} env
 */
function usesOwnBackend(env) {
  const e = env || {};
  return BACKEND_KEYS.some((k) => typeof e[k] === 'string' && e[k] !== '');
}

/**
 * True when a launched process may be moved to another account on a limit.
 * The token the account layer itself injected (marked by ACCOUNT_ENV) is not
 * "its own backend" - only what the env carried before that layer counts.
 * @param {Record<string,string>|null|undefined} env the final launch env
 */
function failoverEligible(env) {
  const e = env || {};
  if (!e[ACCOUNT_ENV]) return !usesOwnBackend(e);
  const { CLAUDE_CODE_OAUTH_TOKEN: _injected, ...rest } = e;
  return !usesOwnBackend(rest);
}

/** Drops expired cooldowns and ones for accounts that no longer exist. */
function pruneLimits(limits, accounts, now) {
  const ids = new Set(accounts.map((a) => a.id));
  const out = {};
  for (const [id, at] of Object.entries(limits || {})) {
    if (ids.has(id) && Number.isFinite(at) && at > now) out[id] = at;
  }
  return out;
}

/** Validated store contents; anything malformed is dropped, never thrown. */
function sanitize(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter((a) => a && typeof a.id === 'string' && ID_RE.test(a.id) && isValidToken(a.token))
    .map((a) => ({ id: a.id, label: String(a.label || a.id).slice(0, MAX_LABEL), token: a.token }))
    .slice(0, MAX_ACCOUNTS);
  const rawLimits = raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits) ? raw.limits : {};
  const limits = {};
  for (const a of accounts) {
    if (Number.isFinite(rawLimits[a.id])) limits[a.id] = rawLimits[a.id];
  }
  return { accounts, limits };
}

/**
 * `limits` plus cooldowns known elsewhere (`extra`): for each account the
 * later of the two. Neither input is changed; junk entries are skipped.
 * @param {Record<string,number>} limits
 * @param {Record<string,number>} extra
 */
function mergeLimits(limits, extra) {
  const out = { ...limits };
  for (const [id, at] of Object.entries(extra && typeof extra === 'object' ? extra : {})) {
    if (Number.isFinite(at) && !(out[id] >= at)) out[id] = at;
  }
  return out;
}

/**
 * @param {{file:()=>string|null, safeStorage:()=>object|null, now?:()=>number,
 *   log?:(line:string)=>void, onChange?:()=>void,
 *   extraLimits?:()=>Record<string,number>, onLimitCleared?:(id:string)=>void}} deps
 *   extraLimits: cooldowns remembered outside this store (the God Mode
 *     registry, multi God Mode A3) - merged into every pick, never written
 *   onLimitCleared: Mati ended a cooldown by hand - the registry forgets it too
 */
function createClaudeAccounts(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  let state = { accounts: [], limits: {} };
  let loadedMtime = null;

  // The last extra-limits failure logged: a broken source is read on every
  // pick, so the same error is logged once, not once per pick.
  let extraLimitsError = null;

  /**
   * The stored cooldowns plus the extra ones (deps.extraLimits). A source
   * that throws falls back to the stored ones - picking an account must not
   * fail because God Mode's memory could not be read.
   */
  function effectiveLimits(limits = state.limits) {
    if (!deps.extraLimits) return limits;
    try {
      const merged = mergeLimits(limits, deps.extraLimits());
      extraLimitsError = null;
      return merged;
    } catch (err) {
      const message = (err && err.message) || 'error';
      if (message !== extraLimitsError) log(`claude accounts: extra limits unreadable (${message})`);
      extraLimitsError = message;
      return limits;
    }
  }

  const storage = () => {
    try {
      const s = deps.safeStorage();
      return s && s.isEncryptionAvailable() ? s : null;
    } catch {
      return null;
    }
  };

  /** Re-reads the file when it changed on disk (another process wrote it). */
  function refresh() {
    const file = deps.file();
    if (!file) return;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        state = { accounts: [], limits: {} };
        loadedMtime = null;
      } else {
        log(`claude accounts: cannot stat store (${err && err.code})`);
      }
      return;
    }
    if (mtime === loadedMtime) return;
    const s = storage();
    if (!s) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.v === VERSION && typeof raw.enc === 'string') {
        state = sanitize(JSON.parse(s.decryptString(Buffer.from(raw.enc, 'base64'))));
      }
      loadedMtime = mtime;
    } catch (err) {
      log(`claude accounts: store unreadable (${(err && (err.code || err.name)) || 'error'})`);
    }
  }

  /** @returns {boolean} written */
  function persist(next) {
    const file = deps.file();
    const s = storage();
    if (!file || !s) return false;
    try {
      const enc = s.encryptString(JSON.stringify(next)).toString('base64');
      const tmp = file.replace(/(\.local)?\.json$/, '.tmp.local.json');
      fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, enc }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      state = next;
      loadedMtime = fs.statSync(file).mtimeMs;
      if (deps.onChange) deps.onChange();
      return true;
    } catch (err) {
      log(`claude accounts: could not store (${(err && (err.code || err.name)) || 'error'})`);
      return false;
    }
  }

  const save = (next) => (persist(next) ? { ok: true } : { ok: false, error: 'saveFailed' });

  function active() {
    refresh();
    return pickActive(state.accounts, effectiveLimits(), now());
  }

  /** Public view - never carries a token. */
  function list() {
    refresh();
    const t = now();
    const limits = effectiveLimits();
    const current = pickActive(state.accounts, limits, t);
    return {
      encryption: Boolean(storage()),
      accounts: state.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        active: Boolean(current && current.id === a.id),
        limitedUntil: Number.isFinite(limits[a.id]) && limits[a.id] > t ? limits[a.id] : null,
      })),
    };
  }

  /** @returns {{ok:true,id:string}|{ok:false,error:string}} */
  function add(label, tokenText) {
    refresh();
    const token = extractToken(tokenText);
    if (!token) return { ok: false, error: 'badToken' };
    const name = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL) : '';
    if (!name) return { ok: false, error: 'badLabel' };
    if (!storage()) return { ok: false, error: 'noEncryption' };
    if (state.accounts.some((a) => a.token === token)) return { ok: false, error: 'duplicate' };
    if (state.accounts.length >= MAX_ACCOUNTS) return { ok: false, error: 'tooMany' };
    const id = (now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36)).slice(-12);
    const res = save({ accounts: [...state.accounts, { id, label: name, token }], limits: state.limits });
    return res.ok ? { ok: true, id } : res;
  }

  function remove(id) {
    refresh();
    if (!state.accounts.some((a) => a.id === id)) return { ok: false, error: 'notFound' };
    const accounts = state.accounts.filter((a) => a.id !== id);
    return save({ accounts, limits: pruneLimits(state.limits, accounts, now()) });
  }

  /** Moves an account one place up (towards "preferred"). */
  function moveUp(id) {
    refresh();
    const i = state.accounts.findIndex((a) => a.id === id);
    if (i < 0) return { ok: false, error: 'notFound' };
    if (i === 0) return { ok: true };
    const accounts = [...state.accounts];
    [accounts[i - 1], accounts[i]] = [accounts[i], accounts[i - 1]];
    return save({ accounts, limits: state.limits });
  }

  /** Ends a cooldown (Mati knows the limit is back, or the meter saw it reset). */
  function clearLimit(id) {
    refresh();
    if (deps.onLimitCleared && state.accounts.some((a) => a.id === id)) deps.onLimitCleared(id);
    if (!Number.isFinite(state.limits[id])) return { ok: true };
    const { [id]: _gone, ...limits } = state.limits;
    return save({ accounts: state.accounts, limits });
  }

  /**
   * Marks account `id` as cooling down until `resetsAt` and reports where work
   * should continue. A later reset time than the one already stored wins
   * (a weekly wall outlasts a 5 h one).
   * @param {string|null} id
   * @param {number|null} resetsAt
   * @returns {{switchTo: {id:string,label:string}|null, from: {id:string,label:string}|null}}
   */
  function markLimited(id, resetsAt) {
    refresh();
    const t = now();
    const from = state.accounts.find((a) => a.id === id) || null;
    if (!from) return { switchTo: null, from: null };
    const until = Number.isFinite(resetsAt) && resetsAt > t ? resetsAt : t + UNKNOWN_RESET_MS;
    const prev = Number.isFinite(state.limits[id]) ? state.limits[id] : 0;
    const limits = pruneLimits({ ...state.limits, [id]: Math.max(prev, until) }, state.accounts, t);
    // Kept in memory even if the write fails, so this process still moves on.
    if (!persist({ accounts: state.accounts, limits })) state = { accounts: state.accounts, limits };
    const known = effectiveLimits(limits);
    const next = pickActive(state.accounts, known, t);
    const usable = Boolean(next) && next.id !== id && !(known[next.id] > t);
    log(usable
      ? `claude accounts: "${from.label}" hit its limit - switching to "${next.label}"`
      : `claude accounts: "${from.label}" hit its limit - no other account free`);
    return {
      from: { id: from.id, label: from.label },
      switchTo: usable ? { id: next.id, label: next.label } : null,
    };
  }

  /**
   * Headless jobs (planner, Luna's Work steps) do not carry their account
   * back, so the account that is active right now takes the limit.
   * @param {number|null} resetsAt
   * @returns {boolean} another account is free - retry now
   */
  function failoverActive(resetsAt) {
    const current = active();
    if (!current) return false;
    return Boolean(markLimited(current.id, resetsAt).switchTo);
  }

  /** The active account when it is not cooling down, else null. */
  function freeAccount() {
    refresh();
    const t = now();
    const limits = effectiveLimits();
    const a = pickActive(state.accounts, limits, t);
    return a && !(limits[a.id] > t) ? { id: a.id, label: a.label } : null;
  }

  /** The env keys for one launch (see authLayerFor). */
  const authLayer = (env) => authLayerFor(env, active());

  return { list, add, remove, moveUp, clearLimit, active, freeAccount, markLimited, failoverActive, authLayer };
}

module.exports = {
  createClaudeAccounts,
  mergeLimits,
  pickActive,
  authLayerFor,
  usesOwnBackend,
  failoverEligible,
  extractToken,
  isValidToken,
  sanitize,
  ACCOUNT_ENV,
  UNKNOWN_RESET_MS,
};
