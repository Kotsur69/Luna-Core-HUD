// ============================================================================
// LunaCore - memory_propose: a session asks to remember something (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, section 7 step 5 ("remember this"
// mid-session). The tool itself (input checks, wording) lives in
// src/memorytools.js; this is the store side, and the only one that writes.
//
// What a session proposes is treated like a captured candidate
// (src/memoryextract.js), never more:
//   - saved as `observed` under the tab's own project: an inbox entry that only
//     Mati can approve. Never `global`, never confirmed, no supersedes, no
//     usefulness score; id, source and date are set here, not by the session;
//   - secrets are masked (src/hostscrub.js) before anything reaches the disk,
//     and from there the cloud;
//   - a near-duplicate of a memory of the project or of `global` (confirmed or
//     waiting) is not saved again: its key is returned instead;
//   - at most MAX_PROPOSALS_PER_SESSION per terminal session, so a looping or
//     manipulated session cannot bury the inbox.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { GLOBAL, checkRecord, keyOf, projectFromRepoKey } = require('./memoryrecord');
const { scan, writeRecord, fileFor } = require('./memorystore');
const { nearDuplicate, idFor, CANDIDATE_TYPES } = require('./memoryextract');
const { hasSecret } = require('./memorysync');
const { scrub } = require('./hostscrub');

/** Proposals (saved or answered with an existing key) one terminal session may make. */
const MAX_PROPOSALS_PER_SESSION = 5;
/** Sessions whose count is kept; past this the oldest count is forgotten. */
const MAX_TRACKED_SESSIONS = 500;
/** How much of a session id the source names, as capture does. */
const SESSION_LABEL_CHARS = 8;
/** checkRecord needs an id before the real one can be made from the cleaned title. */
const DRAFT_ID = 'proposed';

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A session id as `source` shows it: a short, plain token. */
const sessionLabel = (raw) =>
  String(raw || '')
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, SESSION_LABEL_CHARS) || 'unknown';

const refuse = (reason) => ({ ok: false, reason });
const MEMORY_EXT = '.md';

/**
 * Every key of `project` that has a file, readable or not. A file that does
 * not parse (a half-done hand edit) is no record, but its name is still taken:
 * a proposal must never be written over it (security review of 2026-11-12).
 * @param {string} dir
 * @param {string} project
 * @param {{records: [string, object][], invalid: {file: string}[]}} scanned
 */
function takenKeys(dir, project, { records, invalid }) {
  const folder = path.dirname(fileFor(dir, `${project}/${DRAFT_ID}`));
  const unreadable = invalid
    .filter(({ file }) => path.dirname(file) === folder && file.endsWith(MEMORY_EXT))
    .map(({ file }) => `${project}/${path.basename(file, MEMORY_EXT)}`);
  return new Set([...records.map(([key]) => key), ...unreadable]);
}

/**
 * The record a proposal becomes, or the reason it cannot be one. Cleaned by
 * checkRecord first, then scrubbed: cleaning removes invisible characters, and
 * one hidden inside a key would otherwise let the key slip past the scrubber.
 * @returns {{record: object}|{reason: string}}
 */
function buildRecord({ project, type, title, body, area, source, today, taken }) {
  const fields = { type, project, ...(area ? { area } : {}), created: today, source, confidence: 'observed', supersedes: [], links: [] };
  const draft = checkRecord({ ...fields, id: DRAFT_ID, title, body });
  if (!draft.record) return { reason: draft.error };
  const clean = { title: scrub(draft.record.title), body: scrub(draft.record.body) };
  const id = idFor(clean.title, project, taken);
  if (!id) return { reason: 'bad-id' };
  const res = checkRecord({ ...fields, id, ...clean });
  if (!res.record) return { reason: res.error };
  // scrub() is idempotent, so this only trips if the scrubber and the sync guard disagree.
  if (hasSecret(res.record)) return { reason: 'secret' };
  return { record: res.record };
}

/**
 * @param {{dir: string, machine: string, now?: () => number}} opts
 *   dir = the mirror folder (memoryPaths().dir); machine = machineName() of this PC
 * @returns {{propose: Function, used: (sessionId: string) => number}}
 */
function createProposer({ dir, machine, now = Date.now }) {
  /** sessionId -> proposals made. In memory only: an app restart starts every tab afresh. */
  const counts = new Map();

  function count(sessionId) {
    const next = (counts.get(sessionId) || 0) + 1;
    counts.delete(sessionId);
    counts.set(sessionId, next);
    if (counts.size > MAX_TRACKED_SESSIONS) counts.delete(counts.keys().next().value);
  }

  /**
   * Saves one proposal as an inbox entry. Inputs were checked by memorytools.js
   * already; everything is checked again here, because this is what writes.
   * @param {{sessionId: string, session?: string, project: unknown, type: unknown,
   *   title: unknown, body: unknown, area?: unknown}} p
   *   sessionId = the terminal session (rate limit); session = its Claude session id (source)
   * @returns {{ok: true, key: string, type: string, created: boolean}|{ok: false, reason: string}}
   *   created = false: a near-duplicate exists and `key` is its key
   */
  function propose({ sessionId, session, project, type, title, body, area }) {
    if (typeof sessionId !== 'string' || !sessionId) return refuse('no-session');
    // projectFromRepoKey never answers `global`: a session cannot file a global memory.
    if (typeof project !== 'string' || projectFromRepoKey(project) !== project) return refuse('no-project');
    if (!CANDIDATE_TYPES.includes(type)) return refuse('bad-type');
    if ((counts.get(sessionId) || 0) >= MAX_PROPOSALS_PER_SESSION) return refuse('rate-limit');

    const scanned = scan(dir);
    const existing = scanned.records.map(([, r]) => r).filter((r) => r.project === project || r.project === GLOBAL);
    const source = `proposed in session ${sessionLabel(session)} on ${machine}`;
    const built = buildRecord({ project, type, title, body, area, source, today: isoDate(now()), taken: takenKeys(dir, project, scanned) });
    if (!built.record) return refuse(built.reason);
    const { record } = built;

    const twin = existing.find((r) => nearDuplicate(r, record));
    if (twin) {
      count(sessionId);
      return { ok: true, key: keyOf(twin), type: twin.type, created: false };
    }
    // The sync may have written this file since the scan: never replace a file.
    if (fs.existsSync(fileFor(dir, keyOf(record)))) return refuse('id-taken');
    writeRecord(dir, record);
    // Counted once on disk: a failed write does not use up the session's allowance.
    count(sessionId);
    return { ok: true, key: keyOf(record), type: record.type, created: true };
  }

  return { propose, used: (sessionId) => counts.get(sessionId) || 0 };
}

module.exports = { createProposer, sessionLabel, MAX_PROPOSALS_PER_SESSION };
