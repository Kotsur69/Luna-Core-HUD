// ============================================================================
// LunaCore - memory capture of a finished God Mode run, once per run (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, "Improvements proposed after phase 4",
// item 7. Decision 49 kept God Mode worker tabs out of session capture: one run
// starts many short sessions. Their lessons are the gotchas the workers hit,
// and the run report already holds those. So when a run's report is written
// (orchestraFinalize.js report -> orchestraWiring.js reportDeps -> main), this
// makes ONE extractor call for the whole run, on the lean session path:
//
//   run digest (src/memoryrundigest.js) -> scrub -> prompt (subject 'run')
//   -> small model -> the same filter as a session (memoryextract.candidatesFrom:
//   checkRecord, secret scan, near-duplicates, usefulness floor, at most five,
//   rejected titles as "not wanted") -> `observed` memories in the inbox.
//
// Their source is `captured from God Mode run <runId> on <machine>`, plus the
// outside-content note when the workers read web, subagent or foreign MCP
// output (decision 61).
//
// Only for a project with memory switched on, and not while its inbox is full
// (MAX_PENDING waiting, as for sessions). A run is never captured twice: a
// ledger entry per run id is written BEFORE the model call, so a second finish
// pass, a Retry or a crash mid-call never pays for the same run again.
//
//   memory-runcapture.local.json  {"runs": {"<runId>": {"at", "project", "reason"}}}
// ============================================================================

'use strict';

const os = require('os');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { GLOBAL, projectFromRepoKey } = require('./memoryrecord');
const { scan, writeRecord } = require('./memorystore');
const { memoryPaths } = require('./memorysync');
const { readEnabled } = require('./memoryprojects');
const { buildPrompt, candidatesFrom, outsideNote, withNote } = require('./memoryextract');
const { pendingCount } = require('./memoryinbox');
const { rejectedTitles } = require('./memorylog');
const { droppedEvents, MAX_PENDING } = require('./memorycapture');
const { runDigest, countRunOutside } = require('./memoryrundigest');
const { RUN_ID_RE } = require('./orchestraReport');
const { createLanding, autoEvent } = require('./memoryautoaccept');
const { scrub } = require('./hostscrub');

const LEDGER_FILE = 'memory-runcapture.local.json';
/** Runs remembered; the oldest go first. Run ids are new per run, so this only bounds the file. */
const MAX_RUNS = 500;
const MAX_REASON_CHARS = 40;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** What the filter dropped, counted by reason: {duplicate: 2, secret: 1}. */
function countReasons(rejected) {
  const counts = {};
  for (const { reason } of rejected) counts[reason] = (counts[reason] || 0) + 1;
  return counts;
}

/**
 * The ledger, rebuilt field by field. A missing or broken file is an empty one
 * (as for session capture): it is only written atomically, so a broken file
 * means a hand edit, and a run is captured at its report, once per finish pass.
 */
function readRunLedger(file) {
  let doc = null;
  try {
    doc = readDoc(file);
  } catch (err) {
    console.error('[memory] run capture ledger unreadable, starting empty:', errText(err));
  }
  const entries = [];
  for (const [id, e] of Object.entries(isObject(doc) && isObject(doc.runs) ? doc.runs : {})) {
    if (!RUN_ID_RE.test(id) || !isObject(e)) continue;
    entries.push([
      id,
      {
        at: Number.isFinite(e.at) ? e.at : 0,
        project: projectFromRepoKey(e.project) || null,
        reason: String(e.reason || '').slice(0, MAX_REASON_CHARS),
      },
    ]);
  }
  // The newest MAX_RUNS by time, whatever order a hand-edited file has.
  return { runs: Object.fromEntries(entries.sort(([, a], [, b]) => a.at - b.at).slice(-MAX_RUNS)) };
}

/**
 * @param {{configDir: string, machine: string,
 *   run: (job: {prompt: string}) => Promise<{ok: boolean, answer?: object, reason?: string}>,
 *   projectOf: (repoPath: string) => string|null,
 *   now?: () => number, onSaved?: (count: number) => void, transcriptsDir?: string,
 *   countOutside?: typeof countRunOutside,
 *   log?: {add: (event: object) => boolean, read: () => object[]}|null}} opts
 *   run = the small-model call (missionrunner.runJob, lean, as for sessions);
 *   projectOf = the memory project of a repository folder (its normalised remote), or null;
 *   log = the memory log (src/memorylog.js): what was proposed goes in, rejected titles come out
 */
function createRunCapture({
  configDir,
  machine,
  run,
  projectOf,
  now = Date.now,
  onSaved = () => {},
  transcriptsDir = CLAUDE_PROJECTS_DIR,
  countOutside = countRunOutside,
  log = null,
}) {
  const paths = memoryPaths(configDir);
  const ledgerFile = path.join(configDir, LEDGER_FILE);
  /** Runs being captured right now: a second report of the same run does not start another call. */
  const inflight = new Set();

  function remember(runId, project, reason) {
    const { runs } = readRunLedger(ledgerFile);
    const next = { ...runs, [runId]: { at: now(), project, reason: String(reason).slice(0, MAX_REASON_CHARS) } };
    const kept = Object.entries(next)
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(-MAX_RUNS);
    writeAtomic(ledgerFile, `${JSON.stringify({ runs: Object.fromEntries(kept) })}\n`);
  }

  function projectFor(repoPath) {
    try {
      return typeof repoPath === 'string' && repoPath ? projectFromRepoKey(projectOf(repoPath)) : null;
    } catch (err) {
      console.error('[memory] run capture: no project for the run:', errText(err));
      return null;
    }
  }

  /** Writes the kept candidates; one that cannot be written does not stop the others. */
  function saveRecords(records) {
    let saved = 0;
    // Opt-in per type: a candidate may land confirmed (src/memoryautoaccept.js).
    const land = createLanding({ file: paths.autoAccept, dir: paths.dir, log, now: now() });
    for (const candidate of records) {
      try {
        const { record, auto } = land(candidate);
        writeRecord(paths.dir, record);
        saved++;
        if (log) log.add({ ev: 'proposed', key: `${record.project}/${record.id}`, type: record.type, usefulness: record.usefulness });
        if (log && auto) log.add(autoEvent(record));
      } catch (err) {
        console.error('[memory] run candidate not written:', errText(err));
      }
    }
    return saved;
  }

  /** The model call and the filter, for a run already in the ledger. */
  /** The run's outside-content count; when it cannot be counted, one (assumed, as for a missing transcript). */
  async function outsideOf(repoPath, view) {
    try {
      return await countOutside({ repoPath, view, transcriptsDir });
    } catch (err) {
      console.error('[memory] run capture: outside content not counted:', errText(err));
      return 1;
    }
  }

  async function extract({ runId, repoPath, view, project, digest }) {
    const today = isoDate(now());
    const outside = await outsideOf(repoPath, view);
    const existing = scan(paths.dir)
      .records.map(([, r]) => r)
      .filter((r) => r.project === project || r.project === GLOBAL);
    const notWanted = log ? rejectedTitles(log.read(), project) : [];
    // The digest quotes worker and test output: mask what looks like a secret before it leaves the machine.
    const res = await run({ prompt: buildPrompt({ digest: scrub(digest.text), project, today, existing, notWanted, subject: 'run' }) });
    if (!res || !res.ok) return { reason: `model-${(res && res.reason) || 'failed'}`, saved: 0, rejected: [] };
    const source = withNote(`captured from God Mode run ${runId} on ${machine}`, outsideNote(outside));
    const { records, rejected } = candidatesFrom(res.answer, { project, today, source, existing });
    const saved = saveRecords(records);
    const reason = saved ? 'saved' : records.length ? 'write-failed' : 'nothing';
    return { reason, saved, rejected };
  }

  /**
   * Captures one finished run, at most once. Never throws.
   * @param {{runId: string, repoPath: string, view: object}} report
   *   view = the orchestra view() the run report was built from
   * @returns {Promise<{handed: boolean, reason: string, saved: number}>}
   *   handed = the run went to the extractor (it is in the ledger from then on);
   *   reason = why it did not, or what came of it
   */
  async function capture({ runId, repoPath, view } = {}) {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || !isObject(view) || view.id !== runId) {
      return { handed: false, reason: 'bad-run', saved: 0 };
    }
    if (inflight.has(runId)) return { handed: false, reason: 'already', saved: 0 };
    inflight.add(runId);
    try {
      const project = projectFor(repoPath);
      if (!project || !readEnabled(paths.projects).includes(project)) return { handed: false, reason: 'disabled', saved: 0 };
      if (readRunLedger(ledgerFile).runs[runId]) return { handed: false, reason: 'already', saved: 0 };
      if (pendingCount(paths.dir, project) >= MAX_PENDING) return { handed: false, reason: 'inbox-full', saved: 0 };
      const digest = runDigest(view);
      if (!digest.ran) return { handed: false, reason: 'nothing-ran', saved: 0 };
      // Before the call: from here on this run is never paid for again, whatever happens next.
      remember(runId, project, 'started');
      let res;
      try {
        res = await extract({ runId, repoPath, view, project, digest });
      } catch (err) {
        console.error('[memory] run capture failed:', errText(err));
        res = { reason: 'failed', saved: 0, rejected: [] };
      }
      remember(runId, project, res.reason);
      if (log) {
        for (const event of droppedEvents(res.rejected, project)) log.add(event);
        log.add({ ev: 'capture', project, reason: res.reason, kept: res.saved, dropped: countReasons(res.rejected) });
      }
      if (res.saved) onSaved(res.saved);
      return { handed: true, reason: res.reason, saved: res.saved };
    } catch (err) {
      // The ledger or the mirror failed: logged, and the run's report goes on.
      console.error('[memory] run capture failed:', errText(err));
      return { handed: false, reason: 'failed', saved: 0 };
    } finally {
      inflight.delete(runId);
    }
  }

  return {
    capture,
    /** @returns {{runs: number}} runs in the ledger */
    status: () => ({ runs: Object.keys(readRunLedger(ledgerFile).runs).length }),
  };
}

module.exports = { createRunCapture, readRunLedger, LEDGER_FILE, MAX_RUNS };
