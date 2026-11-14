// ============================================================================
// LunaCore - God Mode self-healing workers (opt-in: plan option `selfHeal`)
// ----------------------------------------------------------------------------
// A worker that stalls on a recognisable ENVIRONMENT error gets one bounded
// automatic fix before Mati is asked:
//   deps        a missing dependency (Cannot find module 'x', node_modules
//               missing) -> the worktree's dependency install runs again
//               through orchestraDeps.js (fresh). Never a link to another
//               checkout's node_modules (DEPS_RULE in orchestra.js).
//   lock        EBUSY / resource busy -> wait LOCK_RETRY_MS, then resume
//   permission  EPERM / EACCES / permission denied -> wait, then resume once.
//               Windows has no chmod: nothing is shelled out to fix modes.
// Then the worker is resumed ONCE in its own worktree, told what was tried.
// At most one heal per package per kind (pkg.heals), spent before it runs,
// so neither a repeated stall nor a LunaCore restart can loop.
// classifyEnvError / healDecision are pure; createHealer holds the timers.
// ============================================================================

'use strict';

const HEAL_KINDS = Object.freeze(['deps', 'lock', 'permission']);
// Stalls a worker can end in after hitting the environment. Not a timeout,
// a permission prompt or machinery trouble: those have their own handling.
const HEAL_REASONS = new Set(['blocked', 'noMarker', 'verifyFailed']);
// A held file is usually let go within seconds (an indexer, an antivirus).
const LOCK_RETRY_MS = 30 * 1000;
const PERMISSION_RETRY_MS = 30 * 1000;
// Only the end of a long text is classified (a verify tail, the last words).
const MAX_HEAL_TEXT_CHARS = 6000;
const MAX_MATCH_CHARS = 120;

// `Cannot find module 'x'` names a missing dependency only for a bare
// package name. A relative or absolute path is the worker's own code.
const MISSING_MODULE_RE = /Cannot find (?:module|package) ['"`]([^'"`\r\n]{1,200})['"`]/g;
const BARE_SPEC_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@-]+)*$/i;
const DEPS_TEXT_RE =
  /\bnode_modules\b[^\r\n]{0,40}?\b(?:missing|empty|broken|incomplete)\b|\b(?:missing|empty|broken|incomplete)\b[^\r\n]{0,40}?\bnode_modules\b|\bmissing (?:npm )?dependenc(?:y|ies)\b/i;
const LOCK_RE = /\bEBUSY\b|resource busy or locked/i;
const PERMISSION_RE = /\bEPERM\b|\bEACCES\b|\bpermission denied\b|\boperation not permitted\b/i;

const clip = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The environment error a text shows, or null. Dependency trouble wins over
 * a lock, a lock over a permission error (on Windows EPERM is often a lock).
 * @param {unknown} text
 * @returns {null | {kind:'deps'|'lock'|'permission', match:string}}
 */
function classifyEnvError(text) {
  const s = String(text == null ? '' : text).slice(-MAX_HEAL_TEXT_CHARS);
  if (!s.trim()) return null;
  for (const m of s.matchAll(MISSING_MODULE_RE)) {
    if (BARE_SPEC_RE.test(m[1])) return { kind: 'deps', match: clip(m[0], MAX_MATCH_CHARS) };
  }
  const patterns = [
    ['deps', DEPS_TEXT_RE],
    ['lock', LOCK_RE],
    ['permission', PERMISSION_RE],
  ];
  for (const [kind, re] of patterns) {
    const m = re.exec(s);
    if (m) return { kind, match: clip(m[0], MAX_MATCH_CHARS) };
  }
  return null;
}

/** Heal kinds a package already spent (a stored list, shape-checked). */
function normalizeHeals(raw) {
  if (!Array.isArray(raw)) return [];
  return HEAL_KINDS.filter((k) => raw.includes(k));
}

/** The text a stall is classified by: its detail plus the evidence that fits the reason. */
function healText(pkg, reason, detail) {
  const evidence = reason === 'verifyFailed' ? pkg.verifyTail : pkg.lastWords;
  return [detail, evidence].filter((t) => typeof t === 'string' && t).join('\n');
}

/**
 * Whether this stall gets an automatic fix, and which.
 * @param {{root?:string|null, branch?:string|null, heals?:string[], lastWords?:string|null, verifyTail?:string|null}} pkg
 * @param {string} reason the stall reason
 * @param {string|null} detail
 * @returns {null | {kind:'deps'|'lock'|'permission', match:string, delayMs:number}}
 */
function healDecision(pkg, reason, detail) {
  if (!pkg || !HEAL_REASONS.has(reason) || !pkg.root || !pkg.branch) return null;
  const found = classifyEnvError(healText(pkg, reason, detail));
  if (!found || normalizeHeals(pkg.heals).includes(found.kind)) return null;
  const delayMs = found.kind === 'deps' ? 0 : found.kind === 'lock' ? LOCK_RETRY_MS : PERMISSION_RETRY_MS;
  return { ...found, delayMs };
}

/**
 * The section a healed worker's resume brief ends with: what stopped it,
 * what LunaCore did, and that a second hit is reported, not fixed by hand.
 * @param {{kind:string, match:string, delayMs:number}} heal
 */
function healBriefSection(heal) {
  const seconds = Math.round((heal.delayMs || 0) / 1000);
  const did = {
    deps: `LunaCore re-ran this worktree's dependency install (npm ci) after your session stopped on a missing dependency (${heal.match}).`,
    lock: `LunaCore waited ${seconds} s after your session stopped on a locked file (${heal.match}), so whatever held it could let go.`,
    permission: `LunaCore waited ${seconds} s after your session stopped on a permission error (${heal.match}). On Windows this is usually a file another process holds.`,
  }[heal.kind];
  return [
    '## Self-heal (LunaCore)',
    did,
    'Run the step that failed again, then carry on with the task.',
    'If the same error comes back, do not try to repair the environment yourself (no chmod, no icacls, no linking node_modules): end with LUNA_BLOCKED and the error.',
  ].join('\n');
}

/**
 * The heal controller of one run.
 * @param {{
 *   enabled: () => boolean, live: () => boolean, getPkg: (id:string) => object|null,
 *   patch: (id:string, fields:object) => void, record: (id:string, entry:object) => void,
 *   commit: () => void, installDeps: (root:string) => Promise<{ok:boolean, output?:string}>,
 *   resume: (id:string, section:string) => boolean, giveUp: (id:string, reason:string, detail:string|null) => void,
 *   onEvent?: (kind:string, data:object) => void, now: () => number,
 *   setTimer: Function, clearTimer: Function, log?: (line:string) => void,
 * }} opts
 *   resume: reopens the stalled worker with the section appended to its brief;
 *   giveUp: the stall's usual handling (escalation, auto-resume, ask Mati).
 */
function createHealer(opts) {
  const log = opts.log || (() => {});
  const onEvent = opts.onEvent || (() => {});
  /** pkgId -> the heal in flight {kind, match, delayMs, reason, detail, timer} */
  const inFlight = new Map();

  /**
   * Starts a heal for a package that just stalled.
   * @returns {boolean} true = a heal runs; the caller skips its usual stall handling
   */
  function tryHeal(pkg, reason, detail) {
    if (!pkg || opts.enabled() !== true || inFlight.has(pkg.id)) return false;
    const decision = healDecision(pkg, reason, detail);
    if (!decision) return false;
    const entry = { ...decision, reason, detail: detail || null, timer: null };
    inFlight.set(pkg.id, entry);
    // Spent before it runs: a repeated stall or a restart never heals this kind again.
    opts.patch(pkg.id, { heals: [...normalizeHeals(pkg.heals), decision.kind] });
    opts.record(pkg.id, { at: opts.now(), kind: 'heal', reason, detail: `${decision.kind}: ${decision.match}` });
    log(`[heal] ${pkg.id}: ${decision.kind} (${decision.match}) after ${reason}`);
    onEvent('healing', { id: pkg.id, kind: decision.kind });
    if (decision.kind === 'deps') {
      Promise.resolve()
        .then(() => opts.installDeps(pkg.root))
        .then(
          (res) => settle(pkg.id, entry, !!(res && res.ok), res && res.ok ? 'installed' : lastLine(res && res.output)),
          (err) => settle(pkg.id, entry, false, err instanceof Error ? err.message : String(err)),
        );
    } else {
      entry.timer = opts.setTimer(() => settle(pkg.id, entry, true, `waited ${Math.round(decision.delayMs / 1000)} s`), decision.delayMs);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }
    return true;
  }

  /** The fix ran: resume the worker once, or hand the stall to its usual handling. */
  function settle(id, entry, ok, what) {
    // Cancelled meanwhile (kill, Retry by hand): the result is not used.
    if (inFlight.get(id) !== entry) return;
    inFlight.delete(id);
    const pkg = opts.getPkg(id);
    if (!pkg || pkg.state !== 'stalled') return;
    const resumed = ok && opts.live() && opts.resume(id, healBriefSection(entry));
    const outcome = resumed ? 'resumed' : ok ? 'not resumed' : `fix failed - ${clip(what, 100)}`;
    opts.record(id, { at: opts.now(), kind: 'heal', reason: entry.reason, detail: `${entry.kind}: ${outcome}` });
    log(`[heal] ${id}: ${entry.kind} ${outcome}`);
    onEvent(resumed ? 'healed' : 'healFailed', { id, kind: entry.kind });
    if (resumed) {
      opts.commit();
      return;
    }
    opts.giveUp(id, entry.reason, entry.detail);
  }

  function cancel(id) {
    const entry = inFlight.get(id);
    if (!entry) return;
    if (entry.timer) opts.clearTimer(entry.timer);
    inFlight.delete(id);
  }

  function cancelAll() {
    for (const id of [...inFlight.keys()]) cancel(id);
  }

  return {
    tryHeal,
    cancel,
    cancelAll,
    /** A heal in flight keeps the run from settling. */
    busy: () => inFlight.size > 0,
    isHealing: (id) => inFlight.has(id),
    /** The board's view: heals spent and the one running, or null when there is nothing to show. */
    view(pkg) {
      const heals = normalizeHeals(pkg && pkg.heals);
      const running = pkg ? inFlight.get(pkg.id) : null;
      return heals.length || running ? { heals, healing: running ? running.kind : null } : null;
    },
  };
}

function lastLine(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.pop() || 'install failed';
}

module.exports = {
  HEAL_KINDS,
  HEAL_REASONS,
  LOCK_RETRY_MS,
  PERMISSION_RETRY_MS,
  classifyEnvError,
  normalizeHeals,
  healDecision,
  healBriefSection,
  createHealer,
};
