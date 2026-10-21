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
  };
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

/** A `godmode` row ({machine, data}) -> {machine, at, runs} or null. Never throws. */
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
    return { machine: row.machine, at: Math.min(d.at, now), runs };
  } catch {
    return null;
  }
}

/** Every PC's runs, each tagged with its machine, newest first, at most MAX_RUNS. */
function runsFrom(rows, now = Date.now()) {
  const runs = (Array.isArray(rows) ? rows : [])
    .map((r) => parseGodmodePeer(r, now))
    .filter(Boolean)
    .flatMap((p) => p.runs.map((r) => ({ ...r, machine: p.machine })));
  return runs.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_RUNS);
}

module.exports = { runEntry, addRun, parseGodmodePeer, runsFrom, prUrlOf, VERSION, MAX_RUNS };
