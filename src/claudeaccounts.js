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
// USAGE LOGIN (optional, per account): a setup-token cannot read the usage
// endpoint (403, no user:profile scope), so an account may carry `usageDir` -
// the CLAUDE_CONFIG_DIR of a separate `claude auth login` used ONLY to read its
// usage (src/claudeaccountusage.js). Only the path is stored, never a token,
// and only a path strictly inside the home dir survives sanitize().
//
// Storage: one safeStorage-encrypted file (claude-accounts.local.json, same
// pattern as cloudauth.js). No encryption available -> nothing is written;
// a plaintext token never touches disk. The file is re-read when its mtime
// changes, so the HUD and a host-mode process stay in step.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
const MAX_USAGE_DIR = 400;
const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+$/;
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

/**
 * True when `dir` is an absolute, already-normalized path strictly inside
 * `home` (no `..` segments, no other drive, not home itself).
 * @param {unknown} dir
 * @param {string} home
 */
function isUsageDirAllowed(dir, home) {
  if (typeof dir !== 'string' || !dir || dir.length > MAX_USAGE_DIR || dir.includes('\0')) return false;
  if (typeof home !== 'string' || !home || !path.isAbsolute(dir)) return false;
  if (dir.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) return false;
  const resolved = path.resolve(dir);
  const rel = path.relative(path.resolve(home), resolved);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Path equality, case-insensitive on Windows. */
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/**
 * The only two dirs account `id` may read usage from: the main ~/.claude
 * login, or its own ~/.claude-usage-<id>. A tampered store can not point a
 * usage read (or `claude auth status`) at any other folder.
 * @param {unknown} dir
 * @param {string} home
 * @param {string} id
 */
function isUsageDirFor(dir, home, id) {
  if (!isUsageDirAllowed(dir, home) || typeof id !== 'string' || !ID_RE.test(id)) return false;
  return samePath(dir, path.join(home, '.claude')) || samePath(dir, path.join(home, `.claude-usage-${id}`));
}

/** A usage-login email as `claude auth status` reports it, or null. */
function cleanEmail(email) {
  return typeof email === 'string' && email.length <= MAX_EMAIL && EMAIL_RE.test(email) ? email : null;
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

/** One stored account with only its validated fields (usage fields optional). */
function cleanAccount(a, home) {
  const out = { id: a.id, label: String(a.label || a.id).slice(0, MAX_LABEL), token: a.token };
  if (!isUsageDirFor(a.usageDir, home, a.id)) return out;
  const email = cleanEmail(a.usageEmail);
  return email ? { ...out, usageDir: a.usageDir, usageEmail: email } : { ...out, usageDir: a.usageDir };
}

/**
 * Validated store contents; anything malformed is dropped, never thrown. A
 * bad usageDir drops only that field, not the account.
 * @param {unknown} data
 * @param {string} [home] the dir every usageDir must sit inside
 */
function sanitize(data, home = os.homedir()) {
  const raw = data && typeof data === 'object' ? data : {};
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter((a) => a && typeof a.id === 'string' && ID_RE.test(a.id) && isValidToken(a.token))
    .map((a) => cleanAccount(a, home))
    .slice(0, MAX_ACCOUNTS);
  const rawLimits = raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits) ? raw.limits : {};
  const limits = {};
  for (const a of accounts) {
    if (Number.isFinite(rawLimits[a.id])) limits[a.id] = rawLimits[a.id];
  }
  return { accounts, limits };
}

/**
 * @param {{file:()=>string|null, safeStorage:()=>object|null, now?:()=>number,
 *   log?:(line:string)=>void, onChange?:()=>void, homeDir?:()=>string}} deps
 */
function createClaudeAccounts(deps) {
  const now = deps.now || Date.now;
  const homeDir = deps.homeDir || os.homedir;
  const log = deps.log || (() => {});
  let state = { accounts: [], limits: {} };
  let loadedMtime = null;

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
        state = sanitize(JSON.parse(s.decryptString(Buffer.from(raw.enc, 'base64'))), homeDir());
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
    return pickActive(state.accounts, state.limits, now());
  }

  /** Public view - never carries a token. */
  function list() {
    refresh();
    const t = now();
    const current = pickActive(state.accounts, state.limits, t);
    return {
      encryption: Boolean(storage()),
      accounts: state.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        active: Boolean(current && current.id === a.id),
        limitedUntil: Number.isFinite(state.limits[a.id]) && state.limits[a.id] > t ? state.limits[a.id] : null,
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

  /** Manually ends a cooldown (Mati knows the limit is back). */
  function clearLimit(id) {
    refresh();
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
    const next = pickActive(state.accounts, limits, t);
    const usable = Boolean(next) && next.id !== id && !(limits[next.id] > t);
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
    const a = pickActive(state.accounts, state.limits, t);
    return a && !(state.limits[a.id] > t) ? { id: a.id, label: a.label } : null;
  }

  /** The env keys for one launch (see authLayerFor). */
  const authLayer = (env) => authLayerFor(env, active());

  /**
   * Main-process only (the usage reader): every account with its usage login
   * dir. Never carries a token; never sent to the renderer as is.
   * @returns {{id:string,label:string,active:boolean,usageDir:string|null,usageEmail:string|null}[]}
   */
  function usageTargets() {
    refresh();
    const current = pickActive(state.accounts, state.limits, now());
    return state.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      active: Boolean(current && current.id === a.id),
      usageDir: a.usageDir || null,
      usageEmail: a.usageEmail || null,
    }));
  }

  /**
   * Points account `id` at a usage login dir (null disconnects it). The dir
   * must be inside the home dir; the email is display-only.
   * @returns {{ok:true}|{ok:false,error:string}}
   */
  function setUsage(id, usageDir, usageEmail = null) {
    refresh();
    if (!state.accounts.some((a) => a.id === id)) return { ok: false, error: 'notFound' };
    if (usageDir !== null && !isUsageDirFor(usageDir, homeDir(), id)) return { ok: false, error: 'badDir' };
    const email = usageDir === null ? null : cleanEmail(usageEmail);
    const accounts = state.accounts.map((a) => {
      if (a.id !== id) return a;
      const { usageDir: _d, usageEmail: _e, ...rest } = a;
      if (usageDir === null) return rest;
      return email ? { ...rest, usageDir, usageEmail: email } : { ...rest, usageDir };
    });
    return save({ accounts, limits: state.limits });
  }

  return {
    list, add, remove, moveUp, clearLimit, active, freeAccount, markLimited, failoverActive, authLayer,
    usageTargets, setUsage,
  };
}

module.exports = {
  createClaudeAccounts,
  pickActive,
  authLayerFor,
  usesOwnBackend,
  failoverEligible,
  extractToken,
  isValidToken,
  sanitize,
  isUsageDirAllowed,
  isUsageDirFor,
  cleanEmail,
  BACKEND_KEYS,
  ACCOUNT_ENV,
  UNKNOWN_RESET_MS,
};
