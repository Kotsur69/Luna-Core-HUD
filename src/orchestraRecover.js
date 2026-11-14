// ============================================================================
// LunaCore - God Mode recovery playbook: known environment stalls fix
// themselves, Mati is asked once
// ----------------------------------------------------------------------------
// The individual fixes already live in their own modules - the per-worktree
// install (orchestraDeps.js), the serial verify queue (verifyQueue.js), the
// GH013 / secret fix-up round (orchestra.js onPushBlocked / onSecretsFound),
// the launch retry ladder (orchestraLaunchRetry.js), the finalizer interrupt
// on wake (orchestraFinalize.js) and account failover (claudefailover.js).
// This is the one layer above them: it recognises WHY a package stopped and
// calls the fix that matches, at most `maxAttempts` times per cause.
//
//   cause          what it looks like                     automatic action
//   depsMissing    'Cannot find module' / empty            npm ci --ignore-scripts IN THE
//                  node_modules in verify or the hold      PACKAGE WORKTREE, verify again
//                                                          (a held file: temp-folder install;
//                                                          still failing asks 'depsLocked')
//   secretFound    the pre-push scan found key shapes      one fix-up worker round
//   pushBlocked    GH013 push rejection                    one fix-up worker round, push again
//   branchTaken    the branch name exists remotely         push under a suffixed name
//                  with other commits
//   network        push / fetch could not reach origin     retry after 1, 5, 15 min
//   auth           push / fetch refused the credentials    same, unless `gh auth status`
//                                                          fails: then ask at once
//   verifyTimeout  verify past its limit (re-run once      verify again alone with a
//                  by the queue already)                   longer limit
//   verifyLoad     a verify red only on timeouts / EPERM   same
//   stepHung       a finish step whose promise never       abort it, run it again
//                  settles after a wake
//   usageLimit     the account hit its limit               failover, else pause until the
//                                                          reset and resume on its own
//   wakeGit        worktree 'notRepo' / 'gitFailed'        wait 30 s, retry once
//                  just after a wake
//
// Loop guard: attempts are counted from the package's stall history
// (kind 'recover', reason = cause) since the last manual Retry. A cause that
// comes back once its attempts are used stops being retried; when nothing
// automatic will pick the package up again, Mati gets ONE notification per
// cause (pl + en, src/renderer/i18n.js 'orch.recover.*') with what was tried
// and the exact next step. Every fix is written to the stall history, which
// the run report reads ('## Automatic fixes').
//
// Unknown causes keep today's behaviour (stall + diagnosis) and are logged
// with their full output, secret values redacted, so a row can be added.
//
// Everything process-bound is injected (createRecoverer deps); the
// classification and the decision are pure.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { redactSecrets, pushBlockKind } = require('./pushSecrets');
const { VERIFY_TIMEOUT_MS, KILL_GRACE_MS } = require('./orchestraFinish');
const { outputTail } = require('./orchestraDiagnose');

const MIN = 60 * 1000;
const BACKOFF_MS = Object.freeze([1 * MIN, 5 * MIN, 15 * MIN]);
const WAKE_RETRY_MS = 30 * 1000;
// A launch failure this soon after a wake counts as "just after a wake".
const WAKE_WINDOW_MS = 10 * MIN;
// The longer limit of a verify run again after a timeout / load-only failure.
const LONGER_VERIFY_FACTOR = 2;
// A step in flight across a wake that shows no progress for this long after
// it is aborted: longer than any verify that legitimately carries on.
const STEP_WAKE_GRACE_MS = VERIFY_TIMEOUT_MS + KILL_GRACE_MS + 5 * MIN;
// How much of an unknown failure's output goes to the log.
const MAX_LOG_CHARS = 20000;
const MAX_TRIED_CHARS = 160;
const BRANCH_RE = /^(luna|luna-free|luna-plan)\/[a-z0-9-]{1,64}$/;
// The last line of an install that could not get around a file LunaCore
// holds open (orchestraDeps.js LOCKED_TEXT): the ask says to restart LunaCore.
const LOCKED_RE = /locked by LunaCore/i;
// Causes with an ask text but no playbook row of their own.
const ASK_ONLY_CAUSES = Object.freeze(['depsLocked']);

/**
 * The playbook: cause -> automatic action and how often it may run per
 * package (null = no limit: every usage limit is a new one). `label` is
 * what the stall history and the report say was done.
 */
const PLAYBOOK = Object.freeze({
  depsMissing: { action: 'npmCi', maxAttempts: 1, label: 'npm ci --ignore-scripts in the package worktree, then verify again' },
  secretFound: { action: 'fixupRound', maxAttempts: 1, label: 'one fix-up worker round with the scan result' },
  pushBlocked: { action: 'fixupRound', maxAttempts: 1, label: 'one fix-up worker round with the full rejection text, then push again' },
  branchTaken: { action: 'pushRenamed', maxAttempts: 2, label: 'push under a new suffixed branch name' },
  network: { action: 'retryBackoff', maxAttempts: 3, delaysMs: BACKOFF_MS, label: 'push again after a backoff' },
  auth: { action: 'retryBackoff', maxAttempts: 3, delaysMs: BACKOFF_MS, checkAuth: true, label: 'gh auth status, then push again after a backoff' },
  verifyTimeout: { action: 'reverifyLonger', maxAttempts: 1, label: 'verify again alone with a longer limit' },
  verifyLoad: { action: 'reverifyLonger', maxAttempts: 1, label: 'verify again alone with a longer limit (load-only failure)' },
  stepHung: { action: 'restartStep', maxAttempts: 1, label: 'abort the hung step and run it again' },
  usageLimit: { action: 'failover', fallback: 'pauseUntilReset', maxAttempts: null, label: 'account failover, else pause until the reset' },
  wakeGit: { action: 'retryLaunch', maxAttempts: 1, delaysMs: Object.freeze([WAKE_RETRY_MS]), label: 'wait 30 s after the wake, then create the worktree again' },
});

const DEPS_RE = /Cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|node_modules[^\n]{0,40}\b(?:is empty|does not exist|missing)\b/i;
const AUTH_RE =
  /Authentication failed|could not read Username|Permission denied \(publickey|invalid username or password|terminal prompts disabled|Bad credentials|returned error: 40[13]\b|HTTP 40[13]\b|denied to [^\s]+/i;
const BRANCH_TAKEN_RE =
  /\(fetch first\)|\(non-fast-forward\)|Updates were rejected because the (?:remote contains work|tip of your current branch is behind)/i;
const NETWORK_RE =
  /Could not resolve host|Connection (?:timed out|reset|refused|closed)|Failed to connect|unable to access|Network is unreachable|Operation timed out|early EOF|RPC failed|remote end hung up unexpectedly|SSL_|\bTLS\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Could not read from remote repository/i;
// A verify that went red only because the machine was busy.
const LOAD_RE = /test timed out after|timed out after \d+ ?ms|ETIMEDOUT|EPERM|EBUSY|EMFILE|resource busy or locked|Promise resolution is still pending/i;
const REAL_FAILURE_RE = /AssertionError|Expected values to be|SyntaxError|ReferenceError|TypeError|ERR_ASSERTION/;

// Stop reasons that are the worker's or Mati's, not the machine's: no
// playbook row, and no "unknown cause" log either.
const NOT_ENVIRONMENT = new Set([
  'blocked', 'noMarker', 'needsApproval', 'approvalTimeout', 'timeout', 'restarted', 'killed', 'closed',
  'noCommitsFailed', 'conflict', 'depMergeFailed', 'depVerifyFailed', 'badName', 'noCommits', 'exists', 'unsafeBranch',
]);

/** A verify that failed only on timeouts / busy files, never on an assertion. */
function isLoadOnlyFailure(output) {
  const s = String(output || '');
  return LOAD_RE.test(s) && !REAL_FAILURE_RE.test(s) && !DEPS_RE.test(s);
}

/** Why a push / fetch failed, from git's own words. */
function remoteCause(text) {
  const s = String(text || '');
  if (pushBlockKind(s)) return 'pushBlocked';
  if (AUTH_RE.test(s)) return 'auth';
  if (BRANCH_TAKEN_RE.test(s)) return 'branchTaken';
  if (NETWORK_RE.test(s)) return 'network';
  return 'unknown';
}

/**
 * The cause of one failure, or null when it is no stall (a plain test
 * failure is the worker's to fix).
 * @param {{stage?:string, error?:string, detail?:string|null, output?:string|null,
 *   blocked?:string, afterWake?:boolean}} ev
 * @returns {string|null} a PLAYBOOK key, 'unknown', or null
 */
function classify(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const text = `${e.detail || ''}\n${e.output || ''}`;
  switch (e.stage) {
    case 'secrets':
      return 'secretFound';
    case 'verifyTimeout':
      return 'verifyTimeout';
    case 'stepHung':
      return 'stepHung';
    case 'usageLimit':
      return 'usageLimit';
    case 'hold':
      return 'depsMissing';
    case 'verify':
      if (DEPS_RE.test(text)) return 'depsMissing';
      return isLoadOnlyFailure(text) ? 'verifyLoad' : null;
    case 'push':
    case 'fetch':
      return e.blocked ? 'pushBlocked' : remoteCause(text);
    case 'launch':
      return (e.error === 'notRepo' || e.error === 'gitFailed') && e.afterWake ? 'wakeGit' : 'unknown';
    default:
      return 'unknown';
  }
}

/** The history since the last manual Retry (a Retry gives the playbook fresh attempts). */
function sinceRetry(history) {
  const list = Array.isArray(history) ? history.filter((e) => e && typeof e === 'object') : [];
  let last = -1;
  list.forEach((e, i) => {
    if (e.kind === 'retry') last = i;
  });
  return list.slice(last + 1);
}

const attemptsFor = (history, cause) => sinceRetry(history).filter((e) => e.kind === 'recover' && e.reason === cause).length;
const askedFor = (history, cause) => sinceRetry(history).some((e) => e.kind === 'ask' && e.reason === cause);

/**
 * The cause behind a package nothing automatic will pick up again.
 * @param {{error?:string|null, detail?:string|null, verifyTail?:string|null, stallHistory?:object[]}} pkg
 * @param {string} reason
 * @returns {string|null}
 */
function causeOfStop(pkg, reason) {
  const p = pkg || {};
  if (!reason || NOT_ENVIRONMENT.has(reason)) return null;
  switch (reason) {
    case 'installFailed':
    case 'noNodeModules':
      return 'depsMissing';
    case 'verifyFailed':
      return classify({ stage: 'verify', detail: p.detail, output: p.verifyTail });
    case 'verifyTimeout':
    case 'pushBlocked':
    case 'secretFound':
    case 'stepHung':
      return reason;
    case 'stepHungFailed':
      return 'stepHung';
    case 'pushFailed':
      return remoteCause(p.detail);
    case 'notRepo':
    case 'gitFailed':
    case 'worktreeFailed':
      return attemptsFor(p.stallHistory, 'wakeGit') ? 'wakeGit' : 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Pure: what the playbook does about `cause` for a package with `history`.
 * @returns {{type:'act', cause:string, action:string, attempt:number, delayMs:number}
 *   | {type:'escalate', cause:string, attempts:number} | {type:'none', cause:string}}
 */
function decide(history, cause) {
  const row = Object.prototype.hasOwnProperty.call(PLAYBOOK, cause) ? PLAYBOOK[cause] : null;
  if (!row) return { type: 'none', cause };
  const n = attemptsFor(history, cause);
  if (row.maxAttempts !== null && n >= row.maxAttempts) return { type: 'escalate', cause, attempts: n };
  const delays = row.delaysMs || [];
  const delayMs = delays.length ? delays[Math.min(n, delays.length - 1)] : 0;
  return { type: 'act', cause, action: row.action, attempt: n + 1, delayMs };
}

/** `luna/x` -> `luna/x-r2` (attempt 1), `luna/x-r3`, ... - never past the slug cap. */
function suffixedBranch(branch, attempt) {
  const m = BRANCH_RE.exec(String(branch || ''));
  if (!m) return null;
  const base = String(branch).replace(/-r\d+$/, '');
  const suffix = `-r${attempt + 1}`;
  const slug = base.slice(m[1].length + 1).slice(0, 64 - suffix.length);
  const next = `${m[1]}/${slug}${suffix}`;
  return BRANCH_RE.test(next) ? next : null;
}

// ---- the ask: i18n text (src/renderer/i18n.js 'orch.recover.*') -------------

const ASK_PREFIX = 'orch.recover.';
const I18N_FILE = path.join(__dirname, 'renderer', 'i18n.js');

/**
 * The 'orch.recover.*' entries of the renderer dictionary, per language,
 * read from its source with a line scanner (never evaluated).
 * @param {string} source src/renderer/i18n.js
 * @returns {{pl:Object<string,string>, en:Object<string,string>}}
 */
function parseAskTexts(source) {
  const src = String(source || '');
  const enAt = src.indexOf('\n  en: {');
  const blocks = { pl: enAt >= 0 ? src.slice(0, enAt) : src, en: enAt >= 0 ? src.slice(enAt) : '' };
  const out = { pl: {}, en: {} };
  const re = /^\s*'(orch\.recover\.[A-Za-z.]+)':\s*'((?:[^'\\]|\\.)*)',\s*$/;
  for (const lang of ['pl', 'en']) {
    for (const line of blocks[lang].split('\n')) {
      const m = re.exec(line);
      if (m) out[lang][m[1]] = m[2].replace(/\\'/g, "'");
    }
  }
  return out;
}

let cachedTexts = null;

/** The dictionary entries from the shipped i18n file (cached), or empty maps. */
function defaultTexts() {
  if (cachedTexts) return cachedTexts;
  try {
    cachedTexts = parseAskTexts(fs.readFileSync(I18N_FILE, 'utf8'));
  } catch {
    cachedTexts = { pl: {}, en: {} };
  }
  return cachedTexts;
}

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (all, k) => (vars[k] != null ? String(vars[k]) : all));

/**
 * The notification for `cause`, pl and en: title + body (cause, what was
 * tried, the exact next step). A missing key falls back to plain English.
 * @param {string} cause
 * @param {{pkg?:string, dir?:string, branch?:string}} vars
 * @param {{pl:object, en:object}} [texts]
 */
function askText(cause, vars = {}, texts = defaultTexts()) {
  const pick = (lang) => {
    const dict = (texts && texts[lang]) || {};
    const title = dict[`${ASK_PREFIX}title`] || 'God Mode needs you';
    const body = dict[`${ASK_PREFIX}ask.${cause}`] || `${vars.pkg || '?'}: the automatic fix for ${cause} did not help - open the package on the board.`;
    return { title, body: fill(body, { pkg: '?', dir: '?', branch: '?', ...vars }) };
  };
  return { pl: pick('pl'), en: pick('en') };
}

/**
 * Every automatic fix and ask in a run, oldest first, for the report:
 * package entries plus the run's own (integration).
 * @param {{packages?:object[], recoveries?:object[]}} view
 * @returns {Array<{pkg:string|null, at:number|null, kind:string, cause:string, detail:string|null}>}
 */
function recoveryEntries(view) {
  const v = view && typeof view === 'object' ? view : {};
  // 'heal' (orchestraHeal.js) and 'compact' (orchestraContextGuard.js) are automatic steps too.
  const pick = (pkg) => (e) =>
    e && (e.kind === 'recover' || e.kind === 'ask' || e.kind === 'heal' || e.kind === 'compact')
      ? [{ pkg, at: Number.isFinite(e.at) ? e.at : null, kind: e.kind, cause: String(e.reason || ''), detail: e.detail || null }]
      : [];
  const pkgs = (Array.isArray(v.packages) ? v.packages : []).flatMap((p) =>
    (Array.isArray(p && p.stallHistory) ? p.stallHistory : []).flatMap(pick(p.id)),
  );
  const run = (Array.isArray(v.recoveries) ? v.recoveries : []).flatMap(pick(null));
  return [...pkgs, ...run].sort((a, b) => (a.at || 0) - (b.at || 0));
}

// ---- the recoverer ------------------------------------------------------------

const errText = (err) => (err instanceof Error ? err.message : String(err));
const lastLine = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || '';

/**
 * @param {{
 *   getPkg: (id:string) => object|null,
 *   findByRoot?: (dir:string) => object|null,
 *   record: (id:string, entry:{at:number, kind:string, reason:string, detail?:string|null}) => void,
 *   recordRun?: (entry:object) => void,
 *   repoPath?: () => string|null,
 *   installDeps?: (root:string, opts:{fresh:boolean}) => Promise<{ok:boolean, output:string}>,
 *   checkDeps?: (root:string) => {ok:boolean},
 *   refinish?: (id:string, extra?:object) => void,
 *   fixupRound?: (id:string, res:object) => void,
 *   renameBranch?: (root:string, from:string, to:string) => Promise<{ok:boolean, detail?:string}>,
 *   setBranch?: (id:string, branch:string) => void,
 *   ghAuthOk?: () => Promise<boolean|null>,
 *   stall?: (id:string, reason:string, detail?:string|null, extra?:object) => void,
 *   resumeHeld?: () => void,
 *   holdUnfixed?: (res:object, asked:boolean) => void,
 *   refinishRun?: () => void,
 *   failover?: (pkg:object, until:number) => boolean,
 *   notify?: (ask:{pkgId:string|null, cause:string, tried:string[], text:{pl:object, en:object}}) => void,
 *   texts?: {pl:object, en:object},
 *   now?: () => number, setTimer?: Function, clearTimer?: Function, log?: (line:string) => void,
 *   verifyLimitMs?: number, stepGraceMs?: number,
 * }} deps
 */
function createRecoverer(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || (() => {});
  const verifyLimitMs = Number.isFinite(deps.verifyLimitMs) && deps.verifyLimitMs > 0 ? deps.verifyLimitMs : VERIFY_TIMEOUT_MS;
  const stepGraceMs = Number.isFinite(deps.stepGraceMs) && deps.stepGraceMs > 0 ? deps.stepGraceMs : STEP_WAKE_GRACE_MS;
  /** key -> pending automatic action timer (package id, or 'run') */
  const timers = new Map();
  /** package id -> guarded step in flight */
  const steps = new Map();
  /** run-level attempts / asks (integration), per cause */
  const runAttempts = new Map();
  const runAsked = new Set();
  let wokeAt = null;

  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined);

  function note(pkg, cause, what, result) {
    const detail = redactSecrets(`${what}: ${result}`);
    deps.record(pkg.id, { at: now(), kind: 'recover', reason: cause, detail });
    log(`[recover] ${pkg.id}: ${cause} -> ${detail}`);
  }

  function noteRun(kind, cause, raw) {
    const detail = redactSecrets(raw);
    call(deps.recordRun, { at: now(), kind, reason: cause, detail });
    log(`[recover] run: ${cause} -> ${detail}`);
  }

  function arm(key, ms, fn) {
    cancel(key);
    const timer = setTimer(() => {
      timers.delete(key);
      try {
        fn();
      } catch (err) {
        log(`[recover] scheduled action failed: ${errText(err)}`);
      }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.set(key, timer);
  }

  /** Full output of a failure no playbook row knows, secret values redacted. */
  function logUnknown(id, stage, ...texts) {
    const text = redactSecrets(texts.filter(Boolean).map(String).join('\n')).slice(-MAX_LOG_CHARS);
    log(`[recover] ${id}: unknown stall cause (${stage || '?'}) - no playbook entry, stalled as before. Output (secrets redacted):\n${text || '(none)'}`);
  }

  /**
   * ONE notification per cause (since the last manual Retry), pl + en. A
   * depsMissing whose install (temp-folder route included) failed on a file
   * LunaCore itself holds asks as 'depsLocked': restarting LunaCore is the fix.
   */
  function ask(pkg, cause) {
    const entries = sinceRetry(pkg.stallHistory).filter((e) => e.kind === 'recover' && e.reason === cause);
    const askCause = cause === 'depsMissing' && entries.some((e) => LOCKED_RE.test(String(e.detail || ''))) ? 'depsLocked' : cause;
    if (askedFor(pkg.stallHistory, askCause)) return false;
    const tried = entries.map((e) => String(e.detail || '').slice(0, MAX_TRIED_CHARS));
    deps.record(pkg.id, { at: now(), kind: 'ask', reason: askCause, detail: tried.join('; ').slice(0, MAX_TRIED_CHARS) || null });
    const text = askText(askCause, { pkg: pkg.id, dir: pkg.root || '?', branch: pkg.branch || '?' }, deps.texts);
    log(`[recover] ${pkg.id}: ${askCause} still there after ${tried.length} automatic fix(es) - asking once`);
    call(deps.notify, { pkgId: pkg.id, cause: askCause, tried, text });
    return true;
  }

  // ---- the actions ----------------------------------------------------------

  async function npmCi(pkg, cause, after) {
    const row = PLAYBOOK.depsMissing;
    const root = pkg.root;
    const repo = call(deps.repoPath) || null;
    // Only ever the package's own worktree - never the main checkout.
    if (!root || (repo && path.resolve(root) === path.resolve(repo)) || !deps.installDeps) {
      note(pkg, cause, row.label, 'not possible (no package worktree)');
      after(false, 'no package worktree');
      return;
    }
    let res;
    try {
      res = await deps.installDeps(root, { fresh: true });
    } catch (err) {
      res = { ok: false, output: errText(err) };
    }
    const checked = res && res.ok && deps.checkDeps ? deps.checkDeps(root) : { ok: !!(res && res.ok) };
    const ok = !!(res && res.ok && checked && checked.ok);
    note(pkg, cause, row.label, ok ? 'ok' : `failed - ${lastLine(res && res.output) || (checked && checked.detail) || 'still incomplete'}`);
    after(ok, res && res.output);
  }

  async function pushRenamed(pkg, res, d) {
    const row = PLAYBOOK.branchTaken;
    const to = suffixedBranch(pkg.branch, d.attempt);
    let renamed = { ok: false, detail: 'no valid new branch name' };
    if (to && deps.renameBranch && pkg.root) {
      try {
        renamed = await deps.renameBranch(pkg.root, pkg.branch, to);
      } catch (err) {
        renamed = { ok: false, detail: errText(err) };
      }
    }
    if (!renamed || !renamed.ok) {
      note(pkg, 'branchTaken', row.label, `failed - ${(renamed && renamed.detail) || 'git branch -m failed'}`);
      call(deps.stall, pkg.id, 'pushFailed', res.detail || null);
      return;
    }
    call(deps.setBranch, pkg.id, to);
    note(pkg, 'branchTaken', row.label, `renamed to ${to}`);
    call(deps.refinish, pkg.id, { verifiedSha: res.headSha || null });
  }

  async function retryBackoff(pkg, res, d) {
    const row = PLAYBOOK[d.cause];
    if (row.checkAuth && deps.ghAuthOk) {
      let ok = null;
      try {
        ok = await deps.ghAuthOk();
      } catch {
        ok = null;
      }
      if (ok === false) {
        // A retry cannot fix expired credentials: Mati is asked right away.
        note(pkg, d.cause, 'gh auth status', 'failed - not retried');
        call(deps.stall, pkg.id, 'pushFailed', res.detail || null);
        return;
      }
    }
    const mins = Math.round(d.delayMs / MIN);
    note(pkg, d.cause, row.label, `attempt ${d.attempt}/${row.maxAttempts} in ${mins} min`);
    arm(pkg.id, d.delayMs, () => call(deps.refinish, pkg.id, { verifiedSha: res.headSha || null }));
  }

  function background(promise) {
    promise.catch((err) => log(`[recover] action failed: ${errText(err)}`));
  }

  /** Runs the decided action; true = the playbook owns the package now. */
  function act(pkg, res, d) {
    const row = PLAYBOOK[d.cause];
    switch (d.action) {
      case 'npmCi':
        background(
          npmCi(pkg, d.cause, (ok, output) => {
            if (ok) call(deps.refinish, pkg.id, {});
            else {
              // npm can echo a registry URL with its token: redacted and capped first.
              const safe = redactSecrets(String(output || ''));
              call(deps.stall, pkg.id, 'installFailed', lastLine(safe).slice(0, 300) || 'npm ci failed', { verifyTail: outputTail(safe) || null });
            }
          }),
        );
        return true;
      case 'fixupRound':
        // Counted before the round: a second rejection is the same cause again.
        note(pkg, d.cause, row.label, 'sent');
        call(deps.fixupRound, pkg.id, res);
        return true;
      case 'pushRenamed':
        background(pushRenamed(pkg, res, d));
        return true;
      case 'retryBackoff':
        background(retryBackoff(pkg, res, d));
        return true;
      case 'reverifyLonger': {
        const limit = verifyLimitMs * LONGER_VERIFY_FACTOR;
        note(pkg, d.cause, row.label, `limit ${Math.round(limit / MIN)} min`);
        call(deps.refinish, pkg.id, { verifyLimitMs: limit, verifyReruns: 0 });
        return true;
      }
      case 'restartStep':
        note(pkg, d.cause, row.label, 'restarted');
        call(deps.refinish, pkg.id, {});
        return true;
      default:
        return false;
    }
  }

  // ---- the hooks orchestra.js calls -----------------------------------------

  /**
   * A finish (commit / verify / push) did not succeed. True when an
   * automatic fix took the package over; false = orchestra goes on as before
   * (a plain test failure goes to the worker, a used-up cause stalls).
   * @param {object} pkg
   * @param {object} res finishPackage's result
   */
  function onFinish(pkg, res) {
    if (!pkg || !res || res.ok) return false;
    if (res.stage === 'verifyCancelled' || res.stage === 'noCommits') return false;
    const cause = classify(res);
    if (cause === null) return false;
    if (cause === 'unknown') {
      logUnknown(pkg.id, res.stage, res.detail, res.output);
      return false;
    }
    const d = decide(pkg.stallHistory, cause);
    return d.type === 'act' ? act(pkg, res, d) : false;
  }

  /**
   * Nothing automatic will pick the package up again (orchestra markTerminal).
   * A known cause whose fix already ran asks Mati once; an unknown one is
   * logged with its full output.
   * @returns {boolean} true when a notification went out
   */
  function onTerminal(pkg, reason) {
    if (!pkg) return false;
    const cause = causeOfStop(pkg, reason);
    if (!cause) return false;
    if (cause === 'unknown') {
      logUnknown(pkg.id, reason, pkg.detail, pkg.verifyTail);
      return false;
    }
    if (!attemptsFor(pkg.stallHistory, cause)) return false;
    return ask(pkg, cause);
  }

  /**
   * A launch failed. {delayMs} when the playbook retries it (worktree
   * 'notRepo' / 'gitFailed' just after a wake), null = the usual ladder.
   */
  function onLaunchFailed(pkg, result) {
    if (!pkg || !result || result.retryable === true) return null;
    const afterWake = wokeAt !== null && now() - wokeAt <= WAKE_WINDOW_MS;
    const cause = classify({ stage: 'launch', error: result.error, afterWake });
    if (cause !== 'wakeGit') return null;
    const d = decide(pkg.stallHistory, cause);
    if (d.type !== 'act') return null;
    note(pkg, cause, PLAYBOOK.wakeGit.label, `retry in ${Math.round(d.delayMs / 1000)} s`);
    return { delayMs: d.delayMs };
  }

  /**
   * The run is held on a broken node_modules (orchestraDeps.checkNodeModules).
   * True when the package worktree's install was started (Resume follows on
   * its own); false = the hold waits for Mati as before.
   */
  function onHold(res) {
    const pkg = res && res.dir && deps.findByRoot ? deps.findByRoot(res.dir) : null;
    if (!pkg) return false;
    const d = decide(pkg.stallHistory, 'depsMissing');
    if (d.type !== 'act') return false;
    background(
      npmCi(pkg, 'depsMissing', (ok) => {
        if (ok) {
          call(deps.resumeHeld);
          return;
        }
        // Still broken: the hold waits for Mati as before, told once.
        const asked = ask(deps.getPkg(pkg.id) || pkg, 'depsMissing');
        call(deps.holdUnfixed, res, asked);
      }),
    );
    return true;
  }

  /**
   * A worker hit the usage limit: failover to another stored account, else
   * the run pauses until the reset and resumes on its own (orchestra.js).
   * @returns {'failover'|'pause'}
   */
  function onUsageLimit(pkg, until) {
    let switched = false;
    try {
      switched = call(deps.failover, pkg, until) === true;
    } catch {
      switched = false;
    }
    const at = Number.isFinite(until) ? new Date(until).toISOString().slice(0, 16).replace('T', ' ') : '?';
    const result = switched ? 'continued on another account' : `no free account - paused until ${at} UTC, resumes on its own`;
    // Run-level: it is one account for the whole run, and a package's
    // capped stall history keeps its room for the loop guard.
    noteRun('recover', 'usageLimit', `${pkg ? `${pkg.id}: ` : ''}${PLAYBOOK.usageLimit.label}: ${result}`);
    return switched ? 'failover' : 'pause';
  }

  /**
   * The integration failed. A network / auth failure of its fetch or push is
   * run again after a backoff. True when a retry was scheduled.
   * @param {{state?:string, error?:string|null, detail?:string|null}} integ
   */
  function onIntegration(integ, planId = '') {
    if (!integ || integ.state !== 'failed') return false;
    if (integ.error !== 'fetchFailed' && integ.error !== 'pushFailed') return false;
    const cause = remoteCause(integ.detail);
    if (cause !== 'network' && cause !== 'auth') {
      logUnknown('integration', integ.error, integ.detail);
      return false;
    }
    const row = PLAYBOOK[cause];
    const key = `${planId}|${cause}`;
    const n = runAttempts.get(key) || 0;
    if (n >= row.maxAttempts) {
      if (!runAsked.has(key)) {
        runAsked.add(key);
        const text = askText(cause, { pkg: 'integration', dir: call(deps.repoPath) || '?', branch: '?' }, deps.texts);
        noteRun('ask', cause, `${n} automatic retries`);
        call(deps.notify, { pkgId: null, cause, tried: [`${n} x ${row.label}`], text });
      }
      return false;
    }
    runAttempts.set(key, n + 1);
    const delayMs = row.delaysMs[Math.min(n, row.delaysMs.length - 1)];
    noteRun('recover', cause, `${integ.error}: ${row.label}: attempt ${n + 1}/${row.maxAttempts} in ${Math.round(delayMs / MIN)} min`);
    arm('run', delayMs, () => call(deps.refinishRun));
    return true;
  }

  /** The integration went through: the next failure gets fresh attempts. */
  function onIntegrationOk() {
    runAttempts.clear();
    runAsked.clear();
  }

  /**
   * Runs one finish step under the wake watchdog: when the PC woke during
   * it and it shows no progress for stepGraceMs, it settles as
   * {ok:false, stage:'stepHung'} - its late result is ignored.
   * @param {string} id
   * @param {() => Promise<object>} run
   */
  function guardStep(id, run) {
    return new Promise((resolve) => {
      const step = { progressAt: now(), wokeDuring: false, done: false, waiting: false, aborted: false };
      const settle = (r) => {
        if (step.done) return;
        step.done = true;
        if (steps.get(id) === step) steps.delete(id);
        resolve(r);
      };
      step.abort = (r) => {
        // The abandoned step sees this (its verify is skipped when its turn comes).
        step.aborted = true;
        settle(r);
      };
      steps.set(id, step);
      const handle = { isAborted: () => step.aborted };
      Promise.resolve()
        .then(() => run(handle))
        .then(settle, (err) => settle({ ok: false, stage: 'push', detail: errText(err) || 'finish failed' }));
    });
  }

  /** A guarded step moved on (its verify started / re-ran). */
  function stepProgress(id) {
    const step = steps.get(id);
    if (!step) return;
    step.progressAt = now();
    step.waiting = false;
  }

  /**
   * A guarded step waits for its turn in the verify queue or for the
   * charger: waiting is not hanging, the watchdog leaves it alone.
   */
  function stepWaiting(id) {
    const step = steps.get(id);
    if (!step) return;
    step.progressAt = now();
    step.waiting = true;
  }

  /** The PC woke up: steps in flight are watched; launches just after count as after a wake. */
  function onWake() {
    wokeAt = now();
    for (const step of steps.values()) {
      step.wokeDuring = true;
      step.progressAt = wokeAt;
    }
  }

  /** The watchdog tick: aborts the steps that never settled after a wake. */
  function tick() {
    const t = now();
    for (const [id, step] of [...steps.entries()]) {
      if (!step.wokeDuring || step.waiting || t - step.progressAt < stepGraceMs) continue;
      log(`[recover] ${id}: finish step gave no result ${Math.round((t - step.progressAt) / MIN)} min after the wake - aborted`);
      step.abort({ ok: false, stage: 'stepHung', detail: `no result ${Math.round(stepGraceMs / MIN)} min after the PC woke up` });
    }
  }

  function cancel(key) {
    const timer = timers.get(key);
    if (timer) clearTimer(timer);
    timers.delete(key);
  }

  /** A manual Retry: fresh attempts for every cause, no pending automatic action. */
  function onManualRetry(id) {
    cancel(id);
    deps.record(id, { at: now(), kind: 'retry', reason: 'manual', detail: null });
  }

  return {
    onFinish,
    onTerminal,
    onLaunchFailed,
    onHold,
    onUsageLimit,
    onIntegration,
    onIntegrationOk,
    guardStep,
    stepProgress,
    stepWaiting,
    onWake,
    tick,
    onManualRetry,
    cancel,
    cancelAll: () => [...timers.keys()].forEach(cancel),
    /** An automatic action is waiting for its timer (keeps a run from settling). */
    pending: (key) => (key ? timers.has(key) : timers.size > 0),
  };
}

module.exports = {
  PLAYBOOK,
  ASK_ONLY_CAUSES,
  BACKOFF_MS,
  WAKE_RETRY_MS,
  WAKE_WINDOW_MS,
  STEP_WAKE_GRACE_MS,
  LONGER_VERIFY_FACTOR,
  classify,
  remoteCause,
  isLoadOnlyFailure,
  causeOfStop,
  decide,
  attemptsFor,
  suffixedBranch,
  parseAskTexts,
  askText,
  recoveryEntries,
  BRANCH_RE,
  createRecoverer,
};
