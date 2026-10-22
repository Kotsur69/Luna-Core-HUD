// ============================================================================
// LunaCore - God Mode runs over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, same pattern as usagesnapshot.js / repossnapshot.js.
// When a God Mode run is finalized (orchestraFinalize.js report()), the PC
// adds it to its `godmode` snapshot: the last MAX_RUNS runs, newest first.
// The phone lists them and shows each run's packages.
//
// Only the repo NAME travels, never its path. A row is written by another
// machine: untrusted. Strings are capped and stripped of control characters,
// lists are capped, a PR link survives only as an https://github.com/ URL.
//
// While a run is going, the same row also carries `live` (the run right now:
// state, per-package progress, what waits for Mati) and `tabs` (every
// terminal tab's status light, sessionstatus.js). Both are optional, so a
// row written before them still reads. No local path, no terminal output and
// no model text beyond plan / package / to-do titles ever goes in.
// ============================================================================

'use strict';

const VERSION = 1;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const SHA_RE = /^[0-9a-f]{7}$/;
const PR_PREFIX = 'https://github.com/';
const MAX_RUNS = 10;
const MAX_PACKAGES = 50;
const MAX_SUGGESTIONS = 20;
const MAX_ID = 64;
const MAX_TITLE = 200;
const MAX_NAME = 100;
const MAX_BRANCH = 120;
const MAX_STATE = 24;
const MAX_REASON = 300;
const MAX_RULE = 200;
const MAX_URL = 300;
const MAX_COUNT = 1000;
const SELF_CHECK_STATES = ['ok', 'failed', 'none'];
const LIVE_STATES = ['running', 'paused', 'settled', 'killed'];
const LIVE_PACKAGE_STATES = ['queued', 'launched', 'working', 'approval', 'verifying', 'pushed', 'failed', 'killed'];
const TAB_STATES = ['working', 'done', 'idle', 'approval', 'limit', 'dead'];
const MAX_DEPS = 20;
const MAX_TODOS = 10;
const MAX_TABS = 30;
const MAX_ERROR = 40;
const MAX_DETAIL = 160;
const MAX_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// eslint-disable-next-line no-control-regex
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_COUNT, Math.max(0, Math.round(v))) : 0);

/** A PR link the phone may open: github.com only, no spaces, capped. */
function prUrlOf(v) {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || !v.startsWith(PR_PREFIX) || v.length > MAX_URL || /[\s\x00-\x1f\x7f"<>\\]/.test(v)) return null;
  return v;
}

/** The last segment of a path, on either separator - no `path` (the phone imports this). */
const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]+/).filter(Boolean).pop() || '' : '');

/** "verifyFailed - 2 tests failing" (orchestraReport.js reasonOf). */
const reasonOf = (p) => (p.error ? (p.detail ? `${p.error} - ${p.detail}` : String(p.error)) : '');

function cleanPackage(p) {
  if (!isObject(p)) return null;
  const id = clean(p.id, MAX_ID);
  if (!id) return null;
  const sha = typeof p.sha7 === 'string' ? p.sha7.toLowerCase() : '';
  return {
    id,
    title: clean(p.title, MAX_TITLE),
    state: clean(p.state, MAX_STATE),
    branch: clean(p.branch, MAX_BRANCH),
    sha7: SHA_RE.test(sha) ? sha : null,
    prUrl: prUrlOf(p.prUrl),
    reason: clean(p.reason, MAX_REASON),
    escalated: p.escalated === true,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with every local path cut down: a repo / worktree root prefix goes
 * (leaving the repo-relative name), any other absolute path keeps only its
 * last segment. Applied on both sides - a reader trusts no writer.
 */
function scrubPaths(text, roots = []) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const root of roots) {
    if (typeof root !== 'string' || root.length < 3) continue;
    // Either separator, case-insensitive (Windows paths), plus the separator after it.
    const pattern = escapeRe(root.replace(/[\\/]+$/, '')).replace(/\\\\|\//g, '[\\\\/]');
    out = out.replace(new RegExp(`${pattern}[\\\\/]?`, 'gi'), '');
  }
  return out
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|]*/g, (m) => baseName(m))
    .replace(/(^|[\s"'(=])~?\/(?:[^\s/"'`]+\/)+([^\s/"'`]*)/g, (_, pre, last) => `${pre}${last}`);
}

/** One live package, writer or reader side, or null to drop it. */
function cleanLivePackage(p) {
  if (!isObject(p)) return null;
  const id = clean(p.id, MAX_ID);
  if (!id) return null;
  const sha = typeof p.sha7 === 'string' ? p.sha7.toLowerCase() : '';
  const state = LIVE_PACKAGE_STATES.includes(p.state) ? p.state : 'queued';
  const elapsed = typeof p.elapsedMs === 'number' && Number.isFinite(p.elapsedMs) ? Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(p.elapsedMs))) : null;
  return {
    id,
    title: clean(p.title, MAX_TITLE),
    state,
    dependsOn: (Array.isArray(p.dependsOn) ? p.dependsOn : []).slice(0, MAX_DEPS).map((d) => clean(d, MAX_ID)).filter(Boolean),
    sha7: state === 'pushed' && SHA_RE.test(sha) ? sha : null,
    prUrl: prUrlOf(p.prUrl),
    error: clean(p.error, MAX_ERROR),
    detail: clean(scrubPaths(p.detail), MAX_DETAIL),
    elapsedMs: elapsed,
    todos: (Array.isArray(p.todos) ? p.todos : []).slice(0, MAX_TODOS).map((t) => clean(t, MAX_TITLE)).filter(Boolean),
  };
}

/** The `live` section, writer or reader side, or null. */
function cleanLive(l, now) {
  if (!isObject(l) || !LIVE_STATES.includes(l.state) || !isTime(l.startedAt)) return null;
  const opts = isObject(l.options) ? l.options : {};
  return {
    id: clean(l.id, MAX_ID),
    title: clean(l.title, MAX_TITLE),
    baseBranch: clean(l.baseBranch, MAX_BRANCH),
    startedAt: Math.min(l.startedAt, now),
    state: l.state,
    pausedUntil: l.state === 'paused' && isTime(l.pausedUntil) ? l.pausedUntil : null,
    options: { sleepOnLimit: opts.sleepOnLimit === true, shutdownWhenDone: opts.shutdownWhenDone === true },
    packages: (Array.isArray(l.packages) ? l.packages : []).slice(0, MAX_PACKAGES).map(cleanLivePackage).filter(Boolean),
  };
}

/** The `tabs` list, writer or reader side. A label is a folder / profile name, never a path. */
function cleanTabs(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_TABS)
    .map((tab) =>
      isObject(tab)
        ? {
            folder: clean(baseName(tab.folder), MAX_NAME),
            profile: clean(baseName(tab.profile), MAX_NAME),
            state: TAB_STATES.includes(tab.state) ? tab.state : 'idle',
          }
        : null,
    )
    .filter((tab) => tab && (tab.folder || tab.profile));
}

/**
 * A package's live state: the supervisor state, refined by the worker tab's
 * status light. A stall on a permission prompt waits for Mati too.
 */
function livePackageState(p, tabState) {
  switch (p.state) {
    case 'pending':
      return 'queued';
    case 'launched':
      if (tabState === 'approval') return 'approval';
      return tabState === 'working' ? 'working' : 'launched';
    case 'finishing':
      return 'verifying';
    case 'pushed':
    case 'killed':
      return p.state;
    case 'stalled':
      return p.error === 'needsApproval' ? 'approval' : 'failed';
    default:
      return 'failed';
  }
}

function liveRunState(view) {
  if (view.killed) return 'killed';
  if (view.settled) return 'settled';
  return isTime(view.pausedUntil) ? 'paused' : 'running';
}

/**
 * The `live` section from orchestra liveView() ({...view(), repoPath,
 * roots}), or null before a run has started.
 * @param {object|null} view
 * @param {{now?: number, tabState?: (sessionId: string) => string|null}} [opts]
 * @returns {object|null}
 */
function liveEntry(view, { now = Date.now(), tabState = () => null } = {}) {
  if (!isObject(view) || !view.started || !Array.isArray(view.packages)) return null;
  const roots = [view.repoPath, ...(Array.isArray(view.roots) ? view.roots : [])];
  return cleanLive(
    {
      id: view.id,
      title: baseName(view.repoPath),
      baseBranch: view.baseBranch,
      startedAt: isTime(view.runStartedAt) ? view.runStartedAt : now,
      state: liveRunState(view),
      pausedUntil: view.pausedUntil,
      options: view.options,
      packages: view.packages.map((p) => {
        if (!isObject(p)) return null;
        const state = livePackageState(p, p.sessionId ? tabState(p.sessionId) : null);
        const why = state === 'failed' || state === 'approval';
        const running = p.state === 'launched' || p.state === 'finishing';
        return {
          id: p.id,
          title: p.title,
          state,
          dependsOn: p.dependsOn,
          sha7: typeof p.headSha === 'string' ? p.headSha.slice(0, 7) : null,
          prUrl: p.prUrl,
          error: why ? p.error : '',
          detail: why ? scrubPaths(p.detail, roots) : '',
          elapsedMs: running && isTime(p.startedAt) ? now - p.startedAt - (p.pausedMs || 0) : null,
          todos: p.todos,
        };
      }),
    },
    now,
  );
}

/** The `tabs` list from main's session summaries ({folder, profileLabel, status}). */
function tabsEntry(sessions) {
  return cleanTabs(
    (Array.isArray(sessions) ? sessions : []).map((s) =>
      isObject(s) ? { folder: s.folder, profile: s.profileLabel, state: isObject(s.status) ? s.status.state : 'idle' } : null,
    ),
  );
}

/** One run, writer or reader side, or null to drop it. */
function cleanRun(r, now) {
  if (!isObject(r) || !isTime(r.finishedAt)) return null;
  const id = clean(r.id, MAX_ID);
  if (!id) return null;
  const packages = (Array.isArray(r.packages) ? r.packages : []).slice(0, MAX_PACKAGES).map(cleanPackage).filter(Boolean);
  const total = Math.max(count(r.total), packages.length);
  return {
    id,
    finishedAt: Math.min(r.finishedAt, now),
    repoName: clean(r.repoName, MAX_NAME),
    baseBranch: clean(r.baseBranch, MAX_BRANCH),
    workerModel: clean(r.workerModel, MAX_STATE),
    integrationMode: clean(r.integrationMode, MAX_STATE),
    integrationState: clean(r.integrationState, MAX_STATE),
    pushed: Math.min(count(r.pushed), total),
    total,
    packages,
    approvalSuggestions: (Array.isArray(r.approvalSuggestions) ? r.approvalSuggestions : [])
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => clean(s, MAX_RULE))
      .filter(Boolean),
    // GM never blocks 5/5 (the morning report's headline counts). A row
    // written before them reads as zero / 'none'.
    merged: Math.min(count(r.merged), total),
    skipped: count(r.skipped),
    blocked: count(r.blocked),
    manualActions: count(r.manualActions),
    selfCheck: SELF_CHECK_STATES.includes(r.selfCheck) ? r.selfCheck : 'none',
  };
}

/** 'failed' when any check went red, 'ok' when it ran, 'none' when it did not run. */
function selfCheckState(sc) {
  if (!isObject(sc)) return 'none';
  return ['tests', 'syntax', 'smoke'].some((k) => sc[k] === 'failed') ? 'failed' : 'ok';
}

/**
 * A settled run's entry from orchestra view() (with repoPath, as
 * orchestraFinalize report() builds it) and allowSuggestions() output.
 * @returns {object|null}
 */
function runEntry(view, { now = Date.now(), suggestions = [] } = {}) {
  if (!isObject(view) || !Array.isArray(view.packages)) return null;
  const integ = isObject(view.integration) ? view.integration : {};
  return cleanRun(
    {
      id: view.id,
      finishedAt: now,
      repoName: baseName(view.repoPath),
      baseBranch: view.baseBranch,
      workerModel: view.workerModel,
      integrationMode: view.integrationMode || 'branches',
      integrationState: integ.state || 'idle',
      pushed: view.packages.filter((p) => p && p.state === 'pushed').length,
      total: view.packages.length,
      merged: view.packages.filter((p) => p && p.merged === true).length,
      skipped: Array.isArray(integ.skipped) ? integ.skipped.length : 0,
      blocked: view.packages.filter((p) => p && p.state === 'pending' && p.blockedBy).length,
      manualActions: Array.isArray(integ.manualActions) ? integ.manualActions.length : 0,
      selfCheck: selfCheckState(integ.selfCheck),
      packages: view.packages.map((p) =>
        isObject(p)
          ? {
              id: p.id,
              title: p.title,
              state: p.state,
              branch: p.branch,
              sha7: typeof p.headSha === 'string' ? p.headSha.slice(0, 7) : null,
              prUrl: p.prUrl,
              reason: reasonOf(p),
              escalated: p.escalated === true,
            }
          : null,
      ),
      approvalSuggestions: (Array.isArray(suggestions) ? suggestions : []).map((s) => (isObject(s) ? s.rule : null)),
    },
    now,
  );
}

/**
 * The next `godmode` snapshot: `run` in front of the previous snapshot's
 * runs (a rerun of the same plan replaces its old entry), at most MAX_RUNS.
 * `prev` is this PC's own last snapshot, read back from disk: cleaned too.
 */
function addRun(prev, run, { machine, now = Date.now() }) {
  const old = isObject(prev) && prev.v === VERSION && Array.isArray(prev.runs) ? prev.runs : [];
  const fresh = cleanRun(run, now);
  const runs = [fresh, ...old.map((r) => cleanRun(r, now))]
    .filter(Boolean)
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, MAX_RUNS);
  return { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', runs };
}

/**
 * `snap` (this PC's run history, addRun output or null) with the live run
 * and tab lights laid over it and a fresh `at`. A null `live` drops it.
 */
function withLive(snap, { live = null, tabs = [] } = {}, { machine, now = Date.now() }) {
  const base = isObject(snap) && snap.v === VERSION && Array.isArray(snap.runs) ? snap.runs.map((r) => cleanRun(r, now)).filter(Boolean) : [];
  const out = { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', runs: base.slice(0, MAX_RUNS), tabs: cleanTabs(tabs) };
  const l = cleanLive(live, now);
  return l ? { ...out, live: l } : out;
}

/** A `godmode` row ({machine, data}) -> {machine, at, runs, live, tabs} or null. Never throws. */
function parseGodmodePeer(row, now = Date.now()) {
  try {
    if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
    const d = row.data;
    if (!isObject(d) || d.v !== VERSION || !isTime(d.at) || !Array.isArray(d.runs)) return null;
    const runs = d.runs
      .slice(0, MAX_RUNS)
      .map((r) => cleanRun(r, now))
      .filter(Boolean)
      .sort((a, b) => b.finishedAt - a.finishedAt);
    return { machine: row.machine, at: Math.min(d.at, now), runs, live: cleanLive(d.live, now), tabs: cleanTabs(d.tabs) };
  } catch {
    return null;
  }
}

/** A live snapshot older than this gets the 'stale' badge (the PC publishes at least every minute). */
const LIVE_STALE_MS = 2 * 60 * 1000;

/**
 * The newest live run over every PC, tagged with its machine and whether the
 * snapshot is stale, or null.
 * @returns {object|null}
 */
function liveFrom(rows, now = Date.now()) {
  const peers = (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.live)
    .sort((a, b) => b.at - a.at);
  const p = peers[0];
  return p ? { ...p.live, machine: p.machine, at: p.at, stale: now - p.at > LIVE_STALE_MS } : null;
}

/** Every PC's tab lights: [{machine, at, stale, tabs}], newest first, PCs without tabs left out. */
function tabsFrom(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.tabs.length)
    .sort((a, b) => b.at - a.at)
    .map((p) => ({ machine: p.machine, at: p.at, stale: now - p.at > LIVE_STALE_MS, tabs: p.tabs }));
}

/** Counters for the phone's headline: pushed / working / waiting for Mati / pending / failed. */
function liveCounts(live) {
  const c = { pushed: 0, working: 0, waiting: 0, pending: 0, failed: 0 };
  for (const p of isObject(live) && Array.isArray(live.packages) ? live.packages : []) {
    if (p.state === 'pushed') c.pushed += 1;
    else if (p.state === 'approval') c.waiting += 1;
    else if (p.state === 'queued') c.pending += 1;
    else if (p.state === 'failed' || p.state === 'killed') c.failed += 1;
    else c.working += 1;
  }
  return c;
}

/** Every PC's runs, each tagged with its machine, newest first, at most MAX_RUNS. */
function runsFrom(rows, now = Date.now()) {
  const runs = (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter(Boolean)
    .flatMap((p) => p.runs.map((r) => ({ ...r, machine: p.machine })));
  return runs.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_RUNS);
}

module.exports = {
  runEntry,
  addRun,
  parseGodmodePeer,
  runsFrom,
  prUrlOf,
  liveEntry,
  tabsEntry,
  withLive,
  liveFrom,
  tabsFrom,
  liveCounts,
  scrubPaths,
  VERSION,
  MAX_RUNS,
  LIVE_STALE_MS,
};
