// ============================================================================
// LunaCore - God Mode runs over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/tbc_docs/REMOTE_HOST_PLAN.md, same pattern as usagesnapshot.js / repossnapshot.js.
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
//
// Each run also carries what waits for Mati: `needs` (the report's '## Needs
// you' lines) and `manual` (the manual actions to apply live). The snapshot's
// `seen` lists the run ids this PC has opened in the attention inbox
// (src/inbox.js unions them across machines). A row written before any of
// these reads as empty lists.
//
// v2 (docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N4): each run written since also carries
// `needsYou` and `manualActionLines` - the report's Needs-you and Manual
// actions lines for the notification hub on the other PCs, at most
// HUB_MAX_LINES each, HUB_MAX_LINE chars, paths scrubbed, control characters
// out (reportLines()). A run without them (a v1 row, or an older run carried
// over in this PC's history) reads with counts only: the hub then says
// "details in your email". Readers take v1 and v2 rows alike.
//
// `decisions` (optional): the Luna's Work decisions of the PC's current run
// that wait for Mati (src/lunasworkDecisions.js publicDecision). The phone
// answers them through the `todos` cloud scope, never through this row.
// `feedback` (optional, B17): the current run's feedback items with their
// status (src/lunasworkFeedback.js publicFeedback); new feedback goes back
// through the `todos` scope too.
// `queue` (optional, B16): the PC's Luna's Work project queue, in order -
// project labels only (src/lunasworkQueue.js phoneQueue). Read-only on the
// phone: the queue is edited in the HUD panel.
// `plans` (optional, Phone God Mode A): the current plan of each project
// that has one not started yet (src/hostgodmode.js plans()): {planId,
// projectId, repoName, state: planning|ready|failed, errors, packages:
// [{id, title, deps, model}], todos: the picked to-do titles}. Text only,
// paths scrubbed from errors. The phone launches a ready plan by its ids.
// ============================================================================

'use strict';

const { needsFromReport } = require('./godmodeneeds');
const { publicDecisions } = require('./lunasworkDecisions');
const { publicFeedback } = require('./lunasworkFeedback');

const VERSION = 2;
/** Row versions a reader accepts: v1 rows (no hub lines) still parse. */
const READ_VERSIONS = new Set([1, 2]);
const isKnownVersion = (v) => READ_VERSIONS.has(v);
const HUB_MAX_LINES = 10;
const HUB_MAX_LINE = 200;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const SHA_RE = /^[0-9a-f]{7}$/;
const PR_PREFIX = 'https://github.com/';
const MAX_RUNS = 10;
const MAX_PACKAGES = 50;
// Live runs per PC (one God Mode run per project, MULTI_GODMODE_PLAN.md A5).
const MAX_LIVES = 6;
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
const MAX_LINES = 20;
const MAX_LINE = 300;
const MAX_SEEN = 50;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_QUEUE = 20;
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
const PLAN_STATES = ['planning', 'ready', 'failed'];
/** src/hostgodmode.js PROJECT_ID_RE: a HUD project id. */
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

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
  const projectId = typeof l.projectId === 'string' && PROJECT_ID_RE.test(l.projectId) ? l.projectId : null;
  return {
    id: clean(l.id, MAX_ID),
    // The HUD project the run belongs to (optional): the phone's godmode.kill / retry / finish name it.
    ...(projectId ? { projectId } : {}),
    title: clean(l.title, MAX_TITLE),
    baseBranch: clean(l.baseBranch, MAX_BRANCH),
    startedAt: Math.min(l.startedAt, now),
    state: l.state,
    pausedUntil: l.state === 'paused' && isTime(l.pausedUntil) ? l.pausedUntil : null,
    options: { sleepOnLimit: opts.sleepOnLimit === true, shutdownWhenDone: opts.shutdownWhenDone === true },
    packages: (Array.isArray(l.packages) ? l.packages : []).slice(0, MAX_PACKAGES).map(cleanLivePackage).filter(Boolean),
  };
}

/** The `lives` list, writer or reader side: capped, each run cleaned like `live`. */
function cleanLives(list, now) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_LIVES)
    .map((l) => cleanLive(l, now))
    .filter(Boolean);
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
      projectId: view.projectId,
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

/**
 * The `lives` section: one liveEntry per project's run, in the order given
 * (main: the latest to change first). Runs not started yet are left out; each
 * run's paths are scrubbed against its own repo and worktree roots.
 * @param {Array<object|null>} views orchestra liveViews
 * @param {{now?: number, tabState?: (sessionId: string) => string|null}} [opts]
 * @returns {object[]}
 */
function livesEntry(views, opts = {}) {
  return (Array.isArray(views) ? views : [])
    .map((v) => liveEntry(v, opts))
    .filter(Boolean)
    .slice(0, MAX_LIVES);
}

/** The `tabs` list from main's session summaries ({folder, profileLabel, status}). */
function tabsEntry(sessions) {
  return cleanTabs(
    (Array.isArray(sessions) ? sessions : []).map((s) =>
      isObject(s) ? { folder: s.folder, profile: s.profileLabel, state: isObject(s.status) ? s.status.state : 'idle' } : null,
    ),
  );
}

/** Up to MAX_LINES cleaned, non-empty lines. */
const lines = (v) => (Array.isArray(v) ? v : []).slice(0, MAX_LINES).map((l) => clean(l, MAX_LINE)).filter(Boolean);

/**
 * One hub line (v2 `needsYou` / `manualActionLines`): paths scrubbed (against
 * `roots`, then any absolute path down to its last segment), backticks and
 * control / bidi / zero-width characters out, whitespace squeezed, capped.
 * Idempotent, so a reader re-cleaning a writer's line keeps it as it was.
 */
function hubLine(text, roots = []) {
  if (typeof text !== 'string') return '';
  return scrubPaths(text.slice(0, 4 * HUB_MAX_LINE).replace(/`/g, ''), roots)
    // Control, format (zero-width, bidi, soft hyphen, tags) and separator characters.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HUB_MAX_LINE)
    .trim();
}

/** Up to HUB_MAX_LINES unique, non-empty hub lines. */
const hubLines = (v, roots = []) =>
  [...new Set((Array.isArray(v) ? v : []).slice(0, 4 * HUB_MAX_LINES).map((l) => hubLine(l, roots)).filter(Boolean))].slice(0, HUB_MAX_LINES);

/** The '## Manual actions' bullet lines of a run report ([] for 'None.' or no section). */
function manualFromReport(text) {
  const all = String(text || '').slice(0, 60000).split(/\r?\n/);
  const start = all.indexOf('## Manual actions');
  if (start < 0) return [];
  const out = [];
  for (const line of all.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) out.push(line.slice(2));
  }
  return out;
}

/** The Needs-you line that only points at the Manual actions section. */
const isManualPointer = (line) => /manual actions? to apply live/i.test(line);

/**
 * A run report's hub lines: {needsYou, manualActionLines}. The Needs-you
 * section without the self-check's indented output tail and without the
 * pointer to the manual actions (they come as their own lines). The same
 * function feeds this PC's hub (hubcollect.js) and the snapshot the other
 * PCs read, so a line gets the same id - and the same synced done mark -
 * everywhere.
 * @param {string} report  orchestraReport.buildReport markdown
 * @param {string[]} [roots]  repo root(s) cut out of paths
 */
function reportLines(report, roots = []) {
  const needs = (needsFromReport(report, { maxItems: 4 * HUB_MAX_LINES, maxLine: 4 * HUB_MAX_LINE }) || [])
    .filter((l) => !/^\s/.test(l) && !isManualPointer(l))
    .map((l) => l.replace(/^- /, ''));
  return { needsYou: hubLines(needs, roots), manualActionLines: hubLines(manualFromReport(report), roots) };
}

/** One plan package ({id, title, deps, model}), writer or reader side, or null. */
function cleanPlanPackage(p) {
  if (!isObject(p)) return null;
  const id = clean(p.id, MAX_ID);
  if (!id) return null;
  return {
    id,
    title: clean(scrubPaths(p.title), MAX_TITLE),
    deps: (Array.isArray(p.deps) ? p.deps : []).slice(0, MAX_DEPS).map((d) => clean(d, MAX_ID)).filter(Boolean),
    model: clean(p.model, MAX_STATE),
  };
}

/** One project's current plan (see the header's `plans`), or null to drop it. */
function cleanPlan(p) {
  if (!isObject(p) || !PLAN_STATES.includes(p.state)) return null;
  const projectId = clean(p.projectId, MAX_ID);
  if (!projectId) return null;
  return {
    planId: clean(p.planId, MAX_ID) || null,
    projectId,
    repoName: clean(baseName(p.repoName), MAX_NAME),
    state: p.state,
    errors: (Array.isArray(p.errors) ? p.errors : []).slice(0, MAX_LINES).map((e) => clean(scrubPaths(e), MAX_LINE)).filter(Boolean),
    packages: (Array.isArray(p.packages) ? p.packages : []).slice(0, MAX_PACKAGES).map(cleanPlanPackage).filter(Boolean),
    todos: (Array.isArray(p.todos) ? p.todos : []).slice(0, MAX_LINES).map((t) => clean(scrubPaths(t), MAX_TITLE)).filter(Boolean),
  };
}

/** The `plans` list: one per project (the first wins), at most MAX_LIVES. */
function cleanPlans(list) {
  const out = [];
  const seen = new Set();
  for (const p of (Array.isArray(list) ? list : []).slice(0, MAX_LIVES * 2)) {
    const c = cleanPlan(p);
    if (!c || seen.has(c.projectId)) continue;
    seen.add(c.projectId);
    out.push(c);
    if (out.length >= MAX_LIVES) break;
  }
  return out;
}

/** Seen run ids: well-formed, unique, newest first, at most MAX_SEEN. */
const cleanSeen = (v) =>
  [...new Set((Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && RUN_ID_RE.test(id)))].slice(0, MAX_SEEN);

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
    needs: lines(r.needs),
    manual: lines(r.manual),
    // v2 hub lines, only when the run has them: a run without them stays
    // "counts only" even after this PC re-cleans its own history.
    ...(Array.isArray(r.needsYou) || Array.isArray(r.manualActionLines)
      ? { needsYou: hubLines(r.needsYou), manualActionLines: hubLines(r.manualActionLines) }
      : {}),
  };
}

/** A manual action ({kind, what, from}) as one line: 'migration: x.sql'. */
const manualLine = (a) => (isObject(a) && a.what ? `${clean(a.kind, MAX_STATE) || 'note'}: ${clean(a.what, MAX_LINE)}` : null);

/** Manual action lines, each with what the Supabase apply step did to it (' - applied' / ' - failed'). */
function manualLines(integ) {
  const res = isObject(integ.postMerge) && isObject(integ.postMerge.supabase) ? integ.postMerge.supabase : null;
  const items = (res && Array.isArray(res.items) ? res.items : []).filter(isObject);
  const suffix = (a) => {
    const hit = items.find((i) => i.kind === a.kind && i.what === a.what);
    return hit && (hit.state === 'applied' || hit.state === 'failed') ? ` - ${hit.state}` : '';
  };
  return (Array.isArray(integ.manualActions) ? integ.manualActions : []).slice(0, MAX_LINES).map((a) => {
    const line = manualLine(a);
    return line ? `${line}${suffix(a)}` : null;
  });
}

/** 'failed' when any check went red, 'ok' when it ran, 'none' when it did not run. */
function selfCheckState(sc) {
  if (!isObject(sc)) return 'none';
  return ['tests', 'syntax', 'smoke'].some((k) => sc[k] === 'failed') ? 'failed' : 'ok';
}

/**
 * A settled run's entry from orchestra view() (with repoPath, as
 * orchestraFinalize report() builds it), allowSuggestions() output and the
 * report markdown (its '## Needs you' section becomes `needs`).
 * @returns {object|null}
 */
function runEntry(view, { now = Date.now(), suggestions = [], report = '' } = {}) {
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
      // Scrubbed like the hub lines: the report names local paths.
      needs: (needsFromReport(report, { maxItems: MAX_LINES, maxLine: MAX_LINE }) || []).map((l) => scrubPaths(l, [view.repoPath])),
      manual: manualLines(integ),
      // Only the repo root is cut (not the worktree roots): this PC's hub
      // reads the same lines from the report, which names the repo only.
      ...reportLines(report, [view.repoPath]),
    },
    now,
  );
}

const seenOf = (snap) => (isObject(snap) && isKnownVersion(snap.v) ? cleanSeen(snap.seen) : []);
/** A snapshot this PC (or a reader) can build on: v1 or v2 with a runs list. */
const runsOf = (snap) => (isObject(snap) && isKnownVersion(snap.v) && Array.isArray(snap.runs) ? snap.runs : []);

/**
 * The next `godmode` snapshot: `run` in front of the previous snapshot's
 * runs (a rerun of the same plan replaces its old entry), at most MAX_RUNS.
 * `prev` is this PC's own last snapshot, read back from disk: cleaned too.
 */
function addRun(prev, run, { machine, now = Date.now() }) {
  const old = runsOf(prev);
  const fresh = cleanRun(run, now);
  const runs = [fresh, ...old.map((r) => cleanRun(r, now))]
    .filter(Boolean)
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, MAX_RUNS);
  return { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', runs, seen: seenOf(prev) };
}

/**
 * The next `godmode` snapshot with run `id` marked seen (in front, capped).
 * Runs are kept as they are (cleaned); an unknown or malformed id changes nothing.
 */
function addSeen(prev, id, { machine, now = Date.now() }) {
  const old = runsOf(prev);
  const runs = old.map((r) => cleanRun(r, now)).filter(Boolean).slice(0, MAX_RUNS);
  const seen = cleanSeen([...(typeof id === 'string' && RUN_ID_RE.test(id) ? [id] : []), ...seenOf(prev)]);
  return { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', runs, seen };
}

/**
 * `snap` (this PC's run history, addRun output or null) with the live run
 * and tab lights laid over it and a fresh `at`. A null `live` drops it.
 */
/** The project queue (B16): [{label}], capped, labels cleaned. */
function cleanQueue(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_QUEUE)
    .map((e) => (isObject(e) ? clean(e.label, MAX_NAME) : null))
    .filter(Boolean)
    .map((label) => ({ label }));
}

function withLive(snap, { live = null, lives = null, tabs = [], decisions = [], feedback = null, queue = [], plans = [] } = {}, { machine, now = Date.now() }) {
  const base = runsOf(snap).map((r) => cleanRun(r, now)).filter(Boolean);
  const out = { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', runs: base.slice(0, MAX_RUNS), seen: seenOf(snap), tabs: cleanTabs(tabs) };
  const one = cleanLive(live, now);
  // Every live run (`lives`); `live` stays the first one for older phone builds.
  const ls = Array.isArray(lives) ? cleanLives(lives, now) : one ? [one] : [];
  const l = one || ls[0] || null;
  // Luna's Work decisions waiting for Mati (lunasworkDecisions.publicDecision).
  const d = publicDecisions(decisions);
  // Luna's Work feedback of the current run, with each item's status (B17).
  const f = publicFeedback(feedback);
  // Luna's Work project queue (B16): labels only.
  const q = cleanQueue(queue);
  // Plans not started yet, one per project (Phone God Mode A).
  const pl = cleanPlans(plans);
  return {
    ...out,
    ...(l ? { live: l } : {}),
    ...(ls.length ? { lives: ls } : {}),
    ...(d.length ? { decisions: d } : {}),
    ...(f ? { feedback: f } : {}),
    ...(q.length ? { queue: q } : {}),
    ...(pl.length ? { plans: pl } : {}),
  };
}

/** A `godmode` row ({machine, data}) -> {machine, at, runs, live, tabs} or null. Never throws. */
function parseGodmodePeer(row, now = Date.now()) {
  try {
    if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
    const d = row.data;
    if (!isObject(d) || !isKnownVersion(d.v) || !isTime(d.at) || !Array.isArray(d.runs)) return null;
    const runs = d.runs
      .slice(0, MAX_RUNS)
      .map((r) => cleanRun(r, now))
      .filter(Boolean)
      .sort((a, b) => b.finishedAt - a.finishedAt);
    return {
      machine: row.machine,
      at: Math.min(d.at, now),
      runs,
      seen: cleanSeen(d.seen),
      ...livesOf(d, now),
      tabs: cleanTabs(d.tabs),
      decisions: publicDecisions(d.decisions).filter((x) => x.runId),
      feedback: publicFeedback(d.feedback),
      queue: cleanQueue(d.queue),
      plans: cleanPlans(d.plans),
    };
  } catch {
    return null;
  }
}

/**
 * A row's live runs: `lives` when the PC sends it, else its one `live`
 * (a PC build from before several runs at once).
 * @returns {{live: object|null, lives: object[]}}
 */
function livesOf(d, now) {
  const one = cleanLive(d.live, now);
  const lives = Array.isArray(d.lives) ? cleanLives(d.lives, now) : one ? [one] : [];
  return { live: one || lives[0] || null, lives };
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

/**
 * Every live run over every PC, newest PC first, each tagged with its machine
 * and whether the snapshot is stale. Older PC builds count with their one run.
 * @returns {object[]}
 */
function livesFrom(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.lives.length)
    .sort((a, b) => b.at - a.at)
    .flatMap((p) => p.lives.map((l) => ({ ...l, machine: p.machine, at: p.at, stale: now - p.at > LIVE_STALE_MS })));
}

/** Every PC's tab lights: [{machine, at, stale, tabs}], newest first, PCs without tabs left out. */
function tabsFrom(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.tabs.length)
    .sort((a, b) => b.at - a.at)
    .map((p) => ({ machine: p.machine, at: p.at, stale: now - p.at > LIVE_STALE_MS, tabs: p.tabs }));
}

/**
 * Luna's Work decisions waiting for Mati, from the newest PC that publishes
 * any, each tagged with its machine. A PC publishes only its current run's
 * pending ones, so an older row's list is stale once a newer row has its own.
 * @returns {object[]}
 */
function decisionsFrom(rows, now = Date.now()) {
  const peers = (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.decisions.length)
    .sort((a, b) => b.at - a.at);
  const p = peers[0];
  return p ? p.decisions.map((d) => ({ ...d, machine: p.machine, stale: now - p.at > LIVE_STALE_MS })) : [];
}

/**
 * The Luna's Work feedback section (B17) from the newest PC that publishes
 * one: {runId, repoName, items, machine, stale}, or null. A PC publishes it
 * only while a run is going.
 * @returns {object|null}
 */
function feedbackFrom(rows, now = Date.now()) {
  const peers = (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.feedback)
    .sort((a, b) => b.at - a.at);
  const p = peers[0];
  return p ? { ...p.feedback, machine: p.machine, stale: now - p.at > LIVE_STALE_MS } : null;
}

/**
 * The Luna's Work project queue (B16) of every PC that has one, newest
 * first: [{machine, stale, items:[{label}]}].
 * @returns {object[]}
 */
function queueFrom(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.queue.length)
    .sort((a, b) => b.at - a.at)
    .map((p) => ({ machine: p.machine, stale: now - p.at > LIVE_STALE_MS, items: p.queue }));
}

/**
 * Every PC's current plans, newest PC first, each tagged with its machine
 * and whether the snapshot is stale.
 * @returns {object[]}
 */
function plansFrom(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter((p) => p && p.plans.length)
    .sort((a, b) => b.at - a.at)
    .flatMap((p) => p.plans.map((pl) => ({ ...pl, machine: p.machine, stale: now - p.at > LIVE_STALE_MS })));
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
  addSeen,
  parseGodmodePeer,
  runsFrom,
  prUrlOf,
  liveEntry,
  livesEntry,
  tabsEntry,
  withLive,
  liveFrom,
  livesFrom,
  tabsFrom,
  decisionsFrom,
  feedbackFrom,
  queueFrom,
  cleanQueue,
  cleanPlans,
  plansFrom,
  liveCounts,
  scrubPaths,
  hubLine,
  reportLines,
  manualFromReport,
  RUN_ID_RE,
  VERSION,
  HUB_MAX_LINES,
  HUB_MAX_LINE,
  MAX_RUNS,
  MAX_LIVES,
  MAX_SEEN,
  MAX_LINES,
  LIVE_STALE_MS,
};
