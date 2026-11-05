// ============================================================================
// LunaCore - per-account Claude usage (5 h + weekly for every stored account)
// ----------------------------------------------------------------------------
// The failover accounts (src/claudeaccounts.js) run on `claude setup-token`
// tokens, and those can NOT read GET /api/oauth/usage (403: no user:profile
// scope). So each account may get a USAGE-ONLY login: `claude auth login` run
// with CLAUDE_CONFIG_DIR=~/.claude-usage-<id>. That login's token is used for
// nothing but the read-only usage GET; sessions keep running on the setup
// tokens and failover is unchanged. The main ~/.claude login can stand in for
// the account it belongs to ("Use main login" in Settings).
//
//   read()     one entry per stored account {accountId, label, active, main,
//              status, limits[], updatedAt}; status is
//              'ok' | 'reconnect' | 'unconnected' | 'error' | 'loading'.
//              Calls are sequential with a gap (staggered), each account at
//              most once per readEveryMs; a 401/403 marks that account only.
//   renewal    a usage login whose expiresAt is < 10 min away gets
//              `claude auth status` under its own CLAUDE_CONFIG_DIR, then the
//              file is re-read. The main ~/.claude login is never touched -
//              the CLI refreshes that one itself.
//   connect()  `claude auth login` (opens the browser), then `claude auth
//              status` to read back the email.
//
// Main process only: a token is read from disk, sent to api.anthropic.com and
// dropped - it is never stored here, logged, or put into an entry. Every
// process-bound dep (fs, execFile, the GET, the clock) is injected.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { isUsageDirFor, cleanEmail, BACKEND_KEYS, ACCOUNT_ENV } = require('./claudeaccounts');
const { claudeLimits, getClaudeUsage, parseRetryAfter } = require('./usage');

const ID_RE = /^[a-z0-9]{1,20}$/;
/** Just under the watcher's 90 s, so every regular tick reads each account. */
const READ_EVERY_MS = 85 * 1000;
/** Gap between two accounts' GETs inside one pass. */
const STAGGER_MS = 2000;
/** Renew a usage login whose token expires sooner than this. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;
/** One renewal attempt per account per this long (a failing CLI is not looped). */
const RENEW_RETRY_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 30 * 1000;
/** Longest wait after consecutive 429s on one account. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const USAGE_DIR_PREFIX = '.claude-usage-';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const MAX_STATUS_CHARS = 16 * 1024;

/** The usage-login dir LunaCore creates for account `id`. */
const usageDirFor = (home, id) => path.join(home, `${USAGE_DIR_PREFIX}${id}`);

/** The main /login dir (~/.claude). */
const mainDirFor = (home) => path.join(home, '.claude');

/** Path equality, case-insensitive on Windows. */
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
}

/**
 * {accessToken, expiresAt} from <dir>/.credentials.json, or null when the
 * file is missing, corrupt or has no token. Never throws.
 * @param {(file:string) => string} readFile
 * @param {string} dir
 */
function readCredentials(readFile, dir) {
  try {
    const raw = JSON.parse(readFile(path.join(dir, '.credentials.json')));
    const oauth = raw && typeof raw === 'object' ? raw.claudeAiOauth : null;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null };
  } catch {
    return null;
  }
}

/** First JSON object in `text`, or null. */
function firstJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * `claude auth status` output -> {loggedIn, email}. JSON when the CLI prints
 * it, otherwise the first email-looking word of the text.
 * @param {unknown} stdout
 * @returns {{loggedIn: boolean, email: string|null}}
 */
function parseAuthStatus(stdout) {
  // The status is a few lines; a cap keeps the regexes below linear-cheap.
  const text = String(stdout || '').slice(0, MAX_STATUS_CHARS).trim();
  const j = firstJson(text);
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const account = j.account && typeof j.account === 'object' ? j.account : {};
    const oauth = j.oauthAccount && typeof j.oauthAccount === 'object' ? j.oauthAccount : {};
    const email = cleanEmail(j.email || j.emailAddress || account.email || oauth.emailAddress || null);
    const loggedIn = j.loggedIn === true || (j.loggedIn === undefined && Boolean(email));
    return { loggedIn, email };
  }
  const m = /[^\s@<>"'`]+@[^\s@<>"'`]+\.[A-Za-z]{2,}/.exec(text);
  const email = m ? cleanEmail(m[0]) : null;
  return { loggedIn: Boolean(email) && !/not logged in|logged out/i.test(text), email };
}

/**
 * The env for a usage-login CLI call: the app's env without any backend /
 * account / config-dir choice, plus CLAUDE_CONFIG_DIR=<configDir>.
 * @param {Record<string,string|undefined>} base
 * @param {string} configDir
 */
function cleanEnv(base, configDir) {
  const drop = new Set([...BACKEND_KEYS, ACCOUNT_ENV, CONFIG_DIR_ENV].map((k) => k.toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v === 'string' && !drop.has(k.toUpperCase())) env[k] = v;
  }
  return { ...env, [CONFIG_DIR_ENV]: configDir };
}

/** The main login's email from ~/.claude.json (a plain read - nothing is run). */
function mainEmail(readFile, home) {
  try {
    const j = JSON.parse(readFile(path.join(home, '.claude.json')));
    return cleanEmail(j && j.oauthAccount && j.oauthAccount.emailAddress);
  } catch {
    return null;
  }
}

/** What one account's slot starts as before its first read. */
const EMPTY = Object.freeze({ status: 'loading', limits: [], updatedAt: null, nextAt: 0, renewAt: 0, rateStreak: 0 });

/** Only the display fields of a limit (usage.js shape) - nothing else travels. */
const copyLimit = (l) => ({
  window: l.window,
  label: l.label,
  unit: l.unit,
  used: l.used,
  limit: l.limit,
  percentUsed: l.percentUsed,
  resetsAt: typeof l.resetsAt === 'string' ? l.resetsAt : null,
  source: l.source,
});

/**
 * @param {{
 *   accounts: {usageTargets: Function, setUsage: Function},
 *   homeDir?: () => string,
 *   readFile?: (file:string) => string,
 *   mkdir?: (dir:string) => void,
 *   fetchUsage?: (token:string) => Promise<{status:number, body:string, headers:object}>,
 *   execFile?: Function,
 *   claudeBin: () => string|null,
 *   env?: () => Record<string,string|undefined>,
 *   now?: () => number,
 *   sleep?: (ms:number) => Promise<void>,
 *   log?: (line:string) => void,
 *   onConnected?: () => void,
 *   readEveryMs?: number,
 *   staggerMs?: number,
 * }} deps
 */
function createAccountUsage(deps) {
  const homeDir = deps.homeDir || os.homedir;
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const mkdir = deps.mkdir || ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const fetchUsage = deps.fetchUsage || getClaudeUsage;
  const run = deps.execFile || execFile;
  const env = deps.env || (() => process.env);
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log || (() => {});
  const onConnected = deps.onConnected || (() => {});
  const readEveryMs = deps.readEveryMs || READ_EVERY_MS;
  const staggerMs = deps.staggerMs === undefined ? STAGGER_MS : deps.staggerMs;

  /** account id -> its last read state (never a token). */
  let cache = new Map();
  let inFlight = null;
  let loginBusy = false;

  const targets = () => {
    try {
      const list = deps.accounts.usageTargets();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const mainDir = () => mainDirFor(homeDir());
  const isMain = (dir) => samePath(dir, mainDir());

  /** Runs the CLI with no shell; constant args, the dir only ever as env. */
  function runClaude(args, configDir, timeoutMs) {
    let bin = null;
    try {
      bin = deps.claudeBin();
    } catch {
      bin = null;
    }
    if (!bin) return Promise.resolve({ ok: false, error: 'noClaude', stdout: '' });
    return new Promise((resolve) => {
      try {
        run(bin, args, { env: cleanEnv(env(), configDir), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
          (err, stdout) => resolve({
            ok: !err,
            timedOut: Boolean(err && err.killed),
            stdout: String(stdout || ''),
          }));
      } catch (err) {
        log(`usage login: cannot start claude (${(err && err.code) || 'error'})`);
        resolve({ ok: false, error: 'spawn', stdout: '' });
      }
    });
  }

  /** Renews a usage login near expiry; never for the main ~/.claude login. */
  async function maybeRenew(dir, cred, slot, t) {
    const nearExpiry = cred && cred.expiresAt !== null && cred.expiresAt - t < RENEW_BEFORE_MS;
    if (!nearExpiry || isMain(dir) || t < slot.renewAt) return { cred, renewAt: slot.renewAt };
    const renewAt = t + RENEW_RETRY_MS;
    await runClaude(['auth', 'status'], dir, STATUS_TIMEOUT_MS);
    return { cred: readCredentials(readFile, dir), renewAt };
  }

  /** One account's GET -> its next slot. */
  async function readOne(dir, slot) {
    const t = now();
    const renewed = await maybeRenew(dir, readCredentials(readFile, dir), slot, t);
    const base = { ...slot, renewAt: renewed.renewAt, nextAt: t + readEveryMs };
    if (!renewed.cred) return { ...base, status: 'reconnect', limits: [] };
    let res;
    try {
      res = await fetchUsage(renewed.cred.accessToken);
    } catch {
      res = { status: 0, body: '', headers: {} };
    }
    const status = res && res.status;
    if (status === 401 || status === 403) return { ...base, status: 'reconnect', limits: [], rateStreak: 0 };
    if (status === 429) {
      const streak = slot.rateStreak + 1;
      const retry = parseRetryAfter(res.headers && res.headers['retry-after']);
      const backoff = readEveryMs * 2 ** Math.min(streak - 1, 6);
      const wait = Math.min(MAX_BACKOFF_MS, Math.max(readEveryMs, retry === null ? backoff : retry));
      return { ...base, status: 'error', rateStreak: streak, nextAt: t + wait };
    }
    if (status !== 200) return { ...base, status: 'error', rateStreak: 0 };
    let limits = [];
    try {
      limits = claudeLimits(JSON.parse(res.body));
    } catch {
      limits = [];
    }
    if (limits.length === 0) return { ...base, status: 'error', rateStreak: 0 };
    return { ...base, status: 'ok', limits, updatedAt: t, rateStreak: 0 };
  }

  /** The public entry of one account: display fields only, never a token. */
  const entryOf = (target, slot) => ({
    accountId: target.id,
    label: target.label,
    active: Boolean(target.active),
    main: Boolean(target.usageDir) && isMain(target.usageDir),
    status: target.usageDir ? slot.status : 'unconnected',
    limits: target.usageDir ? slot.limits.map(copyLimit) : [],
    updatedAt: target.usageDir ? slot.updatedAt : null,
  });

  /** A slot filled from the watcher's own ~/.claude read (no second GET). */
  function fromMainUsage(slot, mainUsage) {
    const ok = mainUsage && mainUsage.providerId === 'claude' && mainUsage.status === 'ok'
      && !mainUsage.isFallback && Array.isArray(mainUsage.limits) && mainUsage.limits.length > 0;
    if (!ok) return null;
    return { ...slot, status: 'ok', limits: mainUsage.limits, updatedAt: mainUsage.updatedAt || now(), nextAt: 0 };
  }

  async function readAll({ force = false, mainUsage = null } = {}) {
    const list = targets();
    const next = new Map();
    const out = [];
    let reads = 0;
    for (const target of list) {
      let slot = cache.get(target.id) || EMPTY;
      if (target.usageDir) {
        const reused = isMain(target.usageDir) ? fromMainUsage(slot, mainUsage) : null;
        if (reused) {
          slot = reused;
        } else if (force || now() >= slot.nextAt) {
          if (reads > 0 && staggerMs > 0) await sleep(staggerMs);
          reads += 1;
          slot = await readOne(target.usageDir, slot);
        }
        next.set(target.id, slot);
      }
      out.push(entryOf(target, slot));
    }
    cache = next; // drops removed or disconnected accounts
    return out;
  }

  /**
   * One entry per stored account. A pass already running is shared, so a
   * refresh click never doubles the GETs.
   * @param {{force?: boolean, mainUsage?: object|null}} [opts]
   */
  function read(opts) {
    if (!inFlight) inFlight = readAll(opts).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Settings view: the account list plus each account's usage-login state. */
  function decorate(view) {
    const byId = new Map(targets().map((t) => [t.id, t]));
    const accounts = (view && Array.isArray(view.accounts) ? view.accounts : []).map((a) => {
      const target = byId.get(a.id);
      const dir = target && target.usageDir;
      const slot = cache.get(a.id);
      return {
        ...a,
        usage: {
          connected: Boolean(dir),
          main: Boolean(dir) && isMain(dir),
          email: (target && target.usageEmail) || null,
          status: dir ? (slot ? slot.status : 'loading') : 'unconnected',
        },
      };
    });
    return { ...view, accounts };
  }

  const known = (id) => typeof id === 'string' && ID_RE.test(id) && targets().some((t) => t.id === id);

  /** Stores the dir, forgets the old reading and asks for a fresh one. */
  function attach(id, dir, email) {
    const res = deps.accounts.setUsage(id, dir, email);
    if (!res || !res.ok) return res || { ok: false, error: 'saveFailed' };
    cache.delete(id);
    onConnected();
    return { ok: true, email: email || null };
  }

  /**
   * `claude auth login` under ~/.claude-usage-<id> (the CLI opens the
   * browser), then `claude auth status` for the email. One login at a time.
   * @returns {Promise<{ok:true,email:string|null}|{ok:false,error:string}>}
   */
  async function connect(id) {
    if (!known(id)) return { ok: false, error: 'notFound' };
    if (loginBusy) return { ok: false, error: 'busy' };
    const dir = usageDirFor(homeDir(), id);
    if (!isUsageDirFor(dir, homeDir(), id)) return { ok: false, error: 'badDir' };
    loginBusy = true;
    try {
      try {
        mkdir(dir);
      } catch (err) {
        log(`usage login: cannot create its folder (${(err && err.code) || 'error'})`);
        return { ok: false, error: 'badDir' };
      }
      const login = await runClaude(['auth', 'login'], dir, LOGIN_TIMEOUT_MS);
      if (login.error === 'noClaude') return { ok: false, error: 'noClaude' };
      if (login.timedOut) return { ok: false, error: 'timeout' };
      const status = parseAuthStatus((await runClaude(['auth', 'status'], dir, STATUS_TIMEOUT_MS)).stdout);
      if (!status.loggedIn || !readCredentials(readFile, dir)) return { ok: false, error: 'loginFailed' };
      return attach(id, dir, status.email);
    } finally {
      loginBusy = false;
    }
  }

  /** Lets the main ~/.claude login stand in for account `id` (Mati picks). */
  function useMain(id) {
    if (!known(id)) return { ok: false, error: 'notFound' };
    const home = homeDir();
    if (!readCredentials(readFile, mainDirFor(home))) return { ok: false, error: 'noMainLogin' };
    return attach(id, mainDirFor(home), mainEmail(readFile, home));
  }

  /** Forgets account `id`'s usage login (its folder stays on disk). */
  function disconnect(id) {
    if (!known(id)) return { ok: false, error: 'notFound' };
    return attach(id, null, null);
  }

  return { read, decorate, connect, useMain, disconnect };
}

module.exports = {
  createAccountUsage,
  parseAuthStatus,
  readCredentials,
  cleanEnv,
  usageDirFor,
  READ_EVERY_MS,
  RENEW_BEFORE_MS,
};
