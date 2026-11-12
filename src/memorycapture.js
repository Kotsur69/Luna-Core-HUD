// ============================================================================
// LunaCore - memory capture: finished sessions -> candidate memories (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4 (decision 4, section 7).
// Capture happens OUTSIDE the working session: nothing is added to a tab's
// prompt, and nobody is asked anything when a session ends.
//
// main.js tells this module which transcripts belong to tabs of a project with
// memory switched on (track(), and live() on every tick). A ledger remembers,
// per transcript file, how far it has been read:
//
//   memory-capture.local.json
//   {"files": {"<transcript.jsonl>": {"project", "done": <bytes>, "fails", "at": <ms>}},
//    "last": {"at": <ms>, "saved": <n>, "reason": "..."}}
//
// On every tick, a transcript with new text is processed once its session is
// over (the tab is gone) or has been idle for IDLE_MS (a tab left open for
// days still gets captured, piece by piece). Only the text after `done` is
// read, so a resumed session is not captured twice. The ledger is a file, so a
// session that ended with the app is picked up on the next start.
//
// Processing one piece: digest (src/memorydigest.js) -> prompt -> small model
// -> filter (src/memoryextract.js) -> the candidates are written to the mirror
// as `observed` memories. They wait in the inbox (src/memoryinbox.js). A
// candidate the model scored under the usefulness floor never gets there: it
// is only logged (src/memorylog.js, `dropped`) with its score.
//
// A full inbox pauses capture for that project: candidates nobody reviews are
// not worth a model call.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { GLOBAL, projectFromRepoKey } = require('./memoryrecord');
const { scan, writeRecord } = require('./memorystore');
const { memoryPaths } = require('./memorysync');
const { readEnabled } = require('./memoryprojects');
const { digestTranscript } = require('./memorydigest');
const { buildPrompt, candidatesFrom, outsideNote, withNote, LOW_USEFULNESS } = require('./memoryextract');
const { pendingCount } = require('./memoryinbox');
const { rejectedTitles } = require('./memorylog');
const { scrub } = require('./hostscrub');

const LEDGER_FILE = 'memory-capture.local.json';
const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 90 * 1000;
/** A live tab's transcript is captured after this long without a new line. */
const IDLE_MS = 20 * 60 * 1000;
/** A closed tab's CLI may still be flushing its last lines. */
const SETTLE_MS = 60 * 1000;
/** A fully read transcript is forgotten after this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Model calls per tick: a backlog after a long day drains over a few ticks. */
const MAX_PER_TICK = 3;
/** A piece the model failed on this often is skipped. */
const MAX_FAILS = 3;
/** Entries waiting per project before capture pauses for it. */
const MAX_PENDING = 40;
/** Of a longer piece only the end is read. */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A piece with less than this to say is not worth a model call. */
const MIN_DIGEST_CHARS = 600;
const MAX_TRACKED = 500;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const NEWLINE = 0x0a;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The log lines of the candidates dropped for a low usefulness score, so the
 * floor can be checked against what it threw away.
 * @param {{title: string, reason: string, type?: string, usefulness?: number}[]} rejected
 * @param {string} project
 */
const droppedEvents = (rejected, project) =>
  rejected
    .filter((r) => r.reason === LOW_USEFULNESS)
    .map((r) => ({ ev: 'dropped', project, reason: r.reason, type: r.type, title: r.title, usefulness: r.usefulness }));

/** What the filter dropped, counted by reason: {duplicate: 2, secret: 1}. */
function countReasons(rejected) {
  const counts = {};
  for (const { reason } of rejected) counts[reason] = (counts[reason] || 0) + 1;
  return counts;
}

/** The ledger, rebuilt field by field; a missing or broken file is an empty one. */
function readLedger(file) {
  let doc = null;
  try {
    doc = readDoc(file);
  } catch (err) {
    console.error('[memory] capture ledger unreadable, starting empty:', errText(err));
  }
  const files = {};
  for (const [name, e] of Object.entries(isObject(doc) && isObject(doc.files) ? doc.files : {}).slice(0, MAX_TRACKED)) {
    const project = isObject(e) ? projectFromRepoKey(e.project) : null;
    if (!project || !path.isAbsolute(name)) continue;
    files[name] = {
      project,
      done: Number.isSafeInteger(e.done) && e.done > 0 ? e.done : 0,
      fails: Number.isSafeInteger(e.fails) && e.fails > 0 ? e.fails : 0,
      at: Number.isFinite(e.at) ? e.at : 0,
    };
  }
  const last = isObject(doc) && isObject(doc.last) && Number.isFinite(doc.last.at) ? doc.last : null;
  return {
    files,
    last: last ? { at: last.at, saved: Number.isSafeInteger(last.saved) ? last.saved : 0, reason: String(last.reason || '').slice(0, 60) } : null,
  };
}

/**
 * The complete lines of `file` between `from` and its end.
 * @returns {{text: string, end: number}} end = the offset after the last complete line read
 */
function readPiece(file, from, size) {
  const start = Math.max(from, size - MAX_READ_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  let read;
  try {
    read = fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const data = buf.subarray(0, read);
  const lastBreak = data.lastIndexOf(NEWLINE);
  if (lastBreak < 0) return { text: '', end: from };
  // A piece that starts mid-file starts mid-line: drop that first fragment.
  const first = start > from ? data.indexOf(NEWLINE) + 1 : 0;
  return { text: data.subarray(first, lastBreak + 1).toString('utf8'), end: start + lastBreak + 1 };
}

/**
 * Runs the extractor over one piece of a transcript.
 * @param {{text: string, project: string, dir: string, source: string, today: string, notWanted?: string[],
 *   run: (job: {prompt: string}) => Promise<{ok: boolean, answer?: object, reason?: string}>}} opts
 *   notWanted = titles the user rejected lately: the model is told not to propose their kind again
 * @returns {Promise<{ok: true, records: object[], rejected: object[], reason: string, outside: number}|{ok: false, reason: string}>}
 *   records are NOT written here; outside = the digest's count of calls that read outside
 *   content, also noted in each record's `source`
 */
async function extractPiece({ text, project, dir, source, today, run, notWanted = [] }) {
  const digest = digestTranscript(text);
  if (!digest.userTurns || digest.text.length < MIN_DIGEST_CHARS) return { ok: true, records: [], rejected: [], reason: 'too-short', outside: digest.outside };
  const existing = scan(dir)
    .records.map(([, r]) => r)
    .filter((r) => r.project === project || r.project === GLOBAL);
  // The digest leaves this machine a second time here: mask what looks like a secret.
  const res = await run({ prompt: buildPrompt({ digest: scrub(digest.text), project, today, existing, notWanted }) });
  if (!res || !res.ok) return { ok: false, reason: `model-${(res && res.reason) || 'failed'}` };
  // The outside note comes before the ', suggested global' one candidatesFrom may add (memoryextract.js).
  const noted = withNote(source, outsideNote(digest.outside));
  const { records, rejected } = candidatesFrom(res.answer, { project, today, source: noted, existing });
  return { ok: true, records, rejected, reason: records.length ? 'saved' : 'nothing', outside: digest.outside };
}

/**
 * @param {{configDir: string, machine: string,
 *   run: (job: {prompt: string}) => Promise<object>,
 *   live?: () => {file: string|null, project: string|null}[],
 *   now?: () => number, onSaved?: (count: number) => void,
 *   log?: {add: (event: object) => boolean, read: () => object[]}|null}} opts
 *   run = the small-model call (missionrunner.runJob with the app's env);
 *   live = the transcripts of the tabs open right now;
 *   log = the memory log (src/memorylog.js): what was proposed goes in, the rejected titles come out
 */
function createCapture({ configDir, machine, run, live = () => [], now = Date.now, onSaved = () => {}, transcriptsDir = CLAUDE_PROJECTS_DIR, log = null }) {
  const paths = memoryPaths(configDir);
  const ledgerFile = path.join(configDir, LEDGER_FILE);
  const root = path.resolve(transcriptsDir) + path.sep;
  let busy = false;
  let timer = null;
  let interval = null;
  /** Entries track() got while a tick was running. */
  let tracked = [];

  const save =(ledger) => writeAtomic(ledgerFile, `${JSON.stringify(ledger)}\n`);
  /** Only a transcript under Claude Code's own folder is ever opened: the ledger is a file anyone can edit. */
  const isTranscript = (file) => typeof file === 'string' && file.endsWith('.jsonl') && path.resolve(file).startsWith(root);

  function note(ledger, { file, project }) {
    if (!isTranscript(file) || !projectFromRepoKey(project)) return false;
    const known = ledger.files[file];
    if (known && known.project === project) return false;
    if (!known && Object.keys(ledger.files).length >= MAX_TRACKED) return false;
    ledger.files[file] = known ? { ...known, project } : { project, done: 0, fails: 0, at: now() };
    return true;
  }

  /** Remembers a transcript, e.g. when its tab closes. Never throws. */
  function track(entry) {
    try {
      // A tick in flight holds its own copy of the ledger and saves it after
      // each model call: it merges `tracked` first, so this entry is not lost.
      if (busy && entry) tracked.push(entry);
      const ledger = readLedger(ledgerFile);
      if (note(ledger, entry || {})) save(ledger);
    } catch (err) {
      console.error('[memory] capture could not track a session:', errText(err));
    }
  }

  /**
   * One transcript: reads its new part and saves what the extractor keeps.
   * @returns {Promise<{entry: object, reason: string, saved: number, called: boolean}|null>}
   *   null = nothing to do now (a full inbox, no complete new line): the entry stays as it is;
   *   called = whether the model was asked
   */
  async function processFile(file, entry, size) {
    if (pendingCount(paths.dir, entry.project) >= MAX_PENDING) return null;
    const piece = readPiece(file, entry.done, size);
    if (piece.end <= entry.done) return null;
    const source = `captured from session ${path.basename(file, '.jsonl').slice(0, 8)} on ${machine}`;
    let called = false;
    const counted = (job) => {
      called = true;
      return run(job);
    };
    const notWanted = log ? rejectedTitles(log.read(), entry.project) : [];
    const res = await extractPiece({ text: piece.text, project: entry.project, dir: paths.dir, source, today: isoDate(now()), run: counted, notWanted });
    if (!res.ok) {
      const fails = entry.fails + 1;
      // Giving up on a piece moves past it: one bad transcript must not be retried forever.
      const next = fails >= MAX_FAILS ? { ...entry, done: piece.end, fails: 0, at: now() } : { ...entry, fails };
      return { entry: next, reason: res.reason, saved: 0, called };
    }
    let saved = 0;
    for (const record of res.records) {
      try {
        writeRecord(paths.dir, record);
        saved++;
        if (log) log.add({ ev: 'proposed', key: `${record.project}/${record.id}`, type: record.type, usefulness: record.usefulness });
      } catch (err) {
        // One candidate that cannot be written must not make the piece be paid for again.
        console.error('[memory] candidate not written:', errText(err));
      }
    }
    const reason = saved ? 'saved' : res.reason === 'saved' ? 'write-failed' : res.reason;
    if (log) for (const event of droppedEvents(res.rejected, entry.project)) log.add(event);
    // Only a piece the model read is a capture worth counting.
    if (log && called) log.add({ ev: 'capture', project: entry.project, reason, kept: saved, dropped: countReasons(res.rejected) });
    return { entry: { ...entry, done: piece.end, fails: 0, at: now() }, reason, saved, called };
  }

  /**
   * Looks at every tracked transcript once.
   * @returns {Promise<{processed: number, saved: number}>}
   */
  async function tick() {
    if (busy) return { processed: 0, saved: 0 };
    busy = true;
    let processed = 0;
    let calls = 0;
    let saved = 0;
    try {
      const ledger = readLedger(ledgerFile);
      /** Writes the tick's copy, with what track() learned meanwhile. */
      const saveMerged = () => {
        for (const entry of tracked) note(ledger, entry);
        tracked = [];
        save(ledger);
      };
      const open = live().filter((l) => l && l.file);
      const liveFiles = new Set(open.map((l) => l.file));
      let dirty = false;
      for (const l of open) dirty = note(ledger, l) || dirty;
      const enabled = readEnabled(paths.projects);

      for (const [file, entry] of Object.entries(ledger.files)) {
        let stat = null;
        try {
          stat = fs.statSync(file);
        } catch (err) {
          if (!err || err.code !== 'ENOENT') continue; // a locked file is looked at again next tick
        }
        const isLive = liveFiles.has(file);
        const forget = !isTranscript(file) || !stat || !enabled.includes(entry.project) || (stat.size <= entry.done && !isLive && now() - entry.at > KEEP_MS);
        if (forget) {
          delete ledger.files[file];
          dirty = true;
          continue;
        }
        const quiet = now() - stat.mtimeMs;
        // Only model calls count against the budget: a skip must not starve the transcripts after it.
        if (stat.size <= entry.done || quiet < (isLive ? IDLE_MS : SETTLE_MS) || calls >= MAX_PER_TICK) continue;

        const res = await processFile(file, entry, stat.size);
        if (!res) continue;
        processed++;
        if (res.called) calls++;
        saved += res.saved;
        ledger.files[file] = res.entry;
        ledger.last = { at: now(), saved: res.saved, reason: res.reason };
        // Saved after every model call: a crash must not make the next start pay for it again.
        saveMerged();
        dirty = false;
      }
      if (dirty || tracked.length) saveMerged();
    } catch (err) {
      console.error('[memory] capture failed:', errText(err));
    } finally {
      busy = false;
      tracked = [];
    }
    if (saved) onSaved(saved);
    return { processed, saved };
  }

  return {
    track,
    tick,
    start() {
      timer = setTimeout(tick, FIRST_TICK_MS);
      interval = setInterval(tick, TICK_MS);
      interval.unref();
    },
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
    /** @returns {{tracked: number, last: {at: number, saved: number, reason: string}|null}} */
    status() {
      const ledger = readLedger(ledgerFile);
      return { tracked: Object.keys(ledger.files).length, last: ledger.last };
    },
  };
}

module.exports = { createCapture, extractPiece, readPiece, readLedger, droppedEvents, LEDGER_FILE, IDLE_MS, SETTLE_MS, MAX_FAILS, MAX_PENDING, MIN_DIGEST_CHARS };
