// ============================================================================
// LunaCore - repeat-failure detector across God Mode runs (main)
// ----------------------------------------------------------------------------
// orchestraHeal.js self-heals a worker inside one run, and the run capture
// (src/memoryruncapture.js) reads one run at a time. Neither notices the same
// failure ending run after run. This file is the small local ledger that does:
//
//   memory-failures.local.json
//   {"seen": [{"sig": "verify: not ok - ledger", "project", "run", "at": <ms>}]}
//
// Every captured run adds its failure signatures (memoryrundigest.js
// runFailureSignatures: the first verify error line, the stall reasons, the
// skipped-merge reasons, normalised). A signature seen in REPEAT_THRESHOLD or
// more runs of a project within FAILURE_WINDOW_DAYS, that no confirmed memory
// covers yet, goes into the next run digest as a "REPEATED FAILURE" section,
// so the extractor proposes a gotcha for it; that candidate's usefulness is
// raised to REPEATED_USEFULNESS_FLOOR (floorRepeated). No extra model call.
//
// The ledger is per PC and never synced (no configsync provider reads it).
// Entries older than the window are pruned, the file is capped, and a broken
// file is an empty ledger: it only ever costs a missed "repeated" note.
// ============================================================================

'use strict';

const { readDoc, writeAtomic } = require('./projectsync');
const { GLOBAL, projectFromRepoKey } = require('./memoryrecord');
const { nearDuplicate, wordsOf } = require('./memoryextract');
const { normalizeFailure, MAX_SIGNATURE_CHARS } = require('./memoryrundigest');
const { RUN_ID_RE } = require('./orchestraReport');

const FAILURE_LEDGER_FILE = 'memory-failures.local.json';
/** Entries kept at most; the oldest go first. */
const MAX_FAILURE_ENTRIES = 2000;
const FAILURE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = FAILURE_WINDOW_DAYS * DAY_MS;
/** Runs a signature must be seen in before it counts as repeated. */
const REPEAT_THRESHOLD = 3;
/** The least usefulness a candidate about a repeated failure is saved with. */
const REPEATED_USEFULNESS_FLOOR = 80;
/** Share of a failure's words a candidate must name to be about that failure. */
const MENTION_SHARE = 0.5;
/** A shorter normalised failure is too generic to find inside a memory's text. */
const MIN_CONTAINED_CHARS = 12;
const PATH_MARK_RE = /<path>/g;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
// eslint-disable-next-line no-control-regex
const SIGNATURE_RE = /^[^\x00-\x1f\x7f\p{Zl}\p{Zp}]+$/u;
const validSignature = (v) => typeof v === 'string' && v.length <= MAX_SIGNATURE_CHARS && SIGNATURE_RE.test(v);

/** The text of a signature without its `<kind>: ` label. */
const messageOf = (signature) => {
  const at = signature.indexOf(': ');
  return at < 0 ? signature : signature.slice(at + 2);
};

/** The words of a failure that say something (the path placeholder does not). */
const failureWords = (signature) => wordsOf(messageOf(signature).replace(PATH_MARK_RE, ' '));

/**
 * The ledger, rebuilt entry by entry: only entries of the last
 * FAILURE_WINDOW_DAYS, oldest first, at most MAX_FAILURE_ENTRIES.
 * A missing or broken file is an empty ledger.
 * @param {string} file
 * @param {number} now ms
 * @returns {{seen: {sig: string, project: string, run: string, at: number}[]}}
 */
function readFailureLedger(file, now) {
  let doc = null;
  try {
    doc = readDoc(file);
  } catch (err) {
    console.error('[memory] failure ledger unreadable, starting empty:', errText(err));
  }
  const raw = isObject(doc) && Array.isArray(doc.seen) ? doc.seen : [];
  const seen = [];
  for (const e of raw) {
    if (!isObject(e) || !validSignature(e.sig) || typeof e.run !== 'string' || !RUN_ID_RE.test(e.run)) continue;
    const project = projectFromRepoKey(e.project);
    if (!project || !Number.isFinite(e.at) || e.at < now - FAILURE_WINDOW_MS) continue;
    seen.push({ sig: e.sig, project, run: e.run, at: e.at });
  }
  return { seen: seen.sort((a, b) => a.at - b.at).slice(-MAX_FAILURE_ENTRIES) };
}

/**
 * Adds one run's failure signatures to the ledger (each once per run) and
 * writes it back when anything was added.
 * @param {string} file
 * @param {{project: string, runId: string, signatures: string[], now: number}} run
 * @returns {{seen: object[]}} the ledger as it is now
 */
function recordFailures(file, { project, runId, signatures, now }) {
  const ledger = readFailureLedger(file, now);
  const known = new Set(ledger.seen.filter((e) => e.project === project && e.run === runId).map((e) => e.sig));
  const added = [...new Set(signatures)].filter((sig) => validSignature(sig) && !known.has(sig)).map((sig) => ({ sig, project, run: runId, at: now }));
  if (!added.length) return ledger;
  const next = { seen: [...ledger.seen, ...added].slice(-MAX_FAILURE_ENTRIES) };
  writeAtomic(file, `${JSON.stringify(next)}\n`);
  return next;
}

/**
 * The signatures of a project seen in at least `threshold` different runs,
 * the most frequent first.
 * @returns {{signature: string, count: number}[]}
 */
function repeatedFailures(ledger, project, threshold = REPEAT_THRESHOLD) {
  const runs = new Map();
  for (const e of ledger.seen) {
    if (e.project !== project) continue;
    runs.set(e.sig, (runs.get(e.sig) || new Set()).add(e.run));
  }
  return [...runs]
    .map(([signature, ids]) => ({ signature, count: ids.size }))
    .filter((r) => r.count >= threshold)
    .sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
}

/**
 * Whether a memory already covers a failure: it nearly repeats the failure
 * (memoryextract.nearDuplicate), or one of its lines holds the failure text.
 * @param {{title: string, body: string}} record
 * @param {string} signature
 */
function covers(record, signature) {
  const message = messageOf(signature);
  if (nearDuplicate({ title: message, body: '' }, record)) return true;
  if (message.length < MIN_CONTAINED_CHARS) return false;
  return `${record.title}\n${record.body}`.split(/\r?\n/).some((line) => normalizeFailure(line).includes(message));
}

/**
 * The repeated failures no confirmed memory of the project (or global) covers.
 * @param {{signature: string, count: number}[]} repeats repeatedFailures()
 * @param {object[]} records every record of the mirror
 * @param {string} project
 */
function uncoveredRepeats(repeats, records, project) {
  const confirmed = records.filter((r) => r.confidence === 'confirmed' && (r.project === project || r.project === GLOBAL));
  return repeats.filter((r) => !confirmed.some((record) => covers(record, r.signature)));
}

/** Whether a raw candidate of the model is about one of the failures. */
function mentionsFailure(candidate, signature) {
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  const body = typeof candidate.body === 'string' ? candidate.body : '';
  if (covers({ title, body }, signature)) return true;
  const words = failureWords(signature);
  if (!words.size) return false;
  const text = wordsOf(`${title} ${body}`);
  let shared = 0;
  for (const w of words) if (text.has(w)) shared++;
  return shared / words.size >= MENTION_SHARE;
}

/**
 * The model's answer with every candidate about a repeated failure scored at
 * least REPEATED_USEFULNESS_FLOOR. Applied before the extractor's filter, so a
 * low model score cannot drop the gotcha the digest asked for.
 * @param {unknown} answer the parsed model answer
 * @param {{signature: string}[]} repeats the failures the digest named
 * @returns {unknown} a new answer (the input is not changed)
 */
function floorRepeated(answer, repeats) {
  if (!repeats.length || !isObject(answer) || !Array.isArray(answer.candidates)) return answer;
  const candidates = answer.candidates.map((c) => {
    if (!isObject(c) || !repeats.some((r) => mentionsFailure(c, r.signature))) return c;
    // A fraction (0-1 scale) or a missing score counts as no score at all.
    const score = typeof c.usefulness === 'number' && Number.isFinite(c.usefulness) && c.usefulness >= 1 ? c.usefulness : 0;
    return { ...c, usefulness: Math.max(REPEATED_USEFULNESS_FLOOR, score) };
  });
  return { ...answer, candidates };
}

module.exports = {
  readFailureLedger,
  recordFailures,
  repeatedFailures,
  uncoveredRepeats,
  covers,
  floorRepeated,
  FAILURE_LEDGER_FILE,
  MAX_FAILURE_ENTRIES,
  FAILURE_WINDOW_DAYS,
  REPEAT_THRESHOLD,
  REPEATED_USEFULNESS_FLOOR,
};
