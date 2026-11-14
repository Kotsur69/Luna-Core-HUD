// ============================================================================
// LunaCore - the memory graveyard: candidates auto-rejected for a low score
// ----------------------------------------------------------------------------
// A candidate whose capture score is under AUTO_REJECT_BELOW
// (src/memoryextract.js, LOW_USEFULNESS) never reaches the inbox. Session capture (memorycapture.js)
// and God Mode run capture (memoryruncapture.js) keep it here instead, so the
// floor can be checked by hand and a wrongly dropped memory brought back:
//
//   memory-graveyard.local.json
//   {"entries": [{"id", "at": <ms>, "reason", "score": 0-100, "record": {...}}]}
//
// Newest first, at most MAX_GRAVEYARD_ENTRIES, nothing older than
// GRAVEYARD_KEEP_DAYS. The record is the full checked record, its text run
// through the same secret scrub as the rest of capture before it is written.
//
// This is unreviewed model text: the file is LOCAL. It is never synced, never
// on the project card, never searched and never injected anywhere. It leaves
// this file only through restoreEntry(), which writes it to the mirror as an
// `observed` memory, i.e. into the inbox, where Mati decides as for any other
// candidate.
//
// The file can be edited by anyone: every entry is rebuilt and re-checked on
// read, and a broken file is an empty graveyard, never a crash.
// ============================================================================

'use strict';

const crypto = require('crypto');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { checkRecord, keyOf } = require('./memoryrecord');
const { scan, writeRecord, removeRecord } = require('./memorystore');
const { hasSecret } = require('./memorysync');
const { idFor, LOW_USEFULNESS } = require('./memoryextract');
const { scrub } = require('./hostscrub');

const GRAVEYARD_FILE = 'memory-graveyard.local.json';
/** Entries kept; the oldest go first. */
const MAX_GRAVEYARD_ENTRIES = 200;
/** Raw entries read from the file at most: a hand-edited file cannot make a read slow. */
const MAX_RAW_ENTRIES = MAX_GRAVEYARD_ENTRIES * 2;
/** An entry older than this is pruned. */
const GRAVEYARD_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRAVEYARD_KEEP_MS = GRAVEYARD_KEEP_DAYS * DAY_MS;
const MAX_REASON_CHARS = 40;
const MAX_SCORE = 100;
/** An entry id: base-36 time, a dash, 8 hex characters. Never a path. */
const ENTRY_ID_RE = /^[a-z0-9]{1,12}-[0-9a-f]{8}$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
const isEntryId = (v) => typeof v === 'string' && ENTRY_ID_RE.test(v);
const graveyardPath = (configDir) => path.join(configDir, GRAVEYARD_FILE);
const newId = (at) => `${Math.max(0, Math.floor(at)).toString(36).slice(-12)}-${crypto.randomBytes(4).toString('hex')}`;
const reasonOf = (v) =>
  typeof v === 'string'
    ? v
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_REASON_CHARS)
    : '';

/**
 * The record with its free text scrubbed, re-checked; null when it is not a
 * valid record. Carried unknown fields (`extra`) are dropped: the extractor
 * never writes any, so here they can only come from a hand-edited file.
 */
function scrubbedRecord(raw) {
  if (!isObject(raw)) return null;
  const res = checkRecord({
    ...raw,
    title: typeof raw.title === 'string' ? scrub(raw.title) : raw.title,
    body: typeof raw.body === 'string' ? scrub(raw.body) : raw.body,
    ...(typeof raw.source === 'string' ? { source: scrub(raw.source) } : {}),
    ...(typeof raw.usefulness_note === 'string' ? { usefulness_note: scrub(raw.usefulness_note) } : {}),
    extra: undefined,
  });
  return res.record || null;
}

/** One entry rebuilt from untrusted input, or null. */
function cleanEntry(raw, now) {
  if (!isObject(raw) || !isEntryId(raw.id) || !Number.isFinite(raw.at) || raw.at <= 0) return null;
  // A time in the future (the clock was set back) counts as now: a clock fix must not wipe the graveyard.
  const at = Math.min(raw.at, now);
  if (now - at > GRAVEYARD_KEEP_MS) return null;
  const record = scrubbedRecord(raw.record);
  const reason = reasonOf(raw.reason);
  if (!record || !reason) return null;
  const score = Number.isInteger(raw.score) && raw.score >= 0 && raw.score <= MAX_SCORE ? raw.score : null;
  return { id: raw.id, at, reason, score, record };
}

/** Newest first, no repeated id, within the age and count caps. */
function capped(entries, now) {
  const seen = new Set();
  return entries
    .map((e) => cleanEntry(e, now))
    .filter((e) => e && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_GRAVEYARD_ENTRIES);
}

/**
 * Every valid entry, newest first. A missing or broken file is an empty graveyard.
 * @param {string} file graveyardPath(configDir)
 * @param {number} now ms
 * @returns {{id: string, at: number, reason: string, score: number|null, record: object}[]}
 */
function readGraveyard(file, now) {
  let doc = null;
  try {
    doc = readDoc(file);
  } catch (err) {
    console.error('[memory] graveyard unreadable, treated as empty:', errText(err));
    return [];
  }
  // The file is written newest first: a hand-grown list is cut before any entry is checked.
  return capped(isObject(doc) && Array.isArray(doc.entries) ? doc.entries.slice(0, MAX_RAW_ENTRIES) : [], now);
}

const save = (file, entries) => writeAtomic(file, `${JSON.stringify({ entries })}\n`);

/**
 * Keeps the low-usefulness drops of one capture (memoryextract.candidatesFrom
 * `rejected`, the ones carrying their record). Never throws: the graveyard is
 * not worth a failed capture.
 * @param {string} file
 * @param {{reason: string, record?: object, usefulness?: number}[]} rejected
 * @param {number} now ms
 * @returns {number} entries written
 */
function bury(file, rejected, now) {
  try {
    const fresh = (Array.isArray(rejected) ? rejected : [])
      .filter((r) => isObject(r) && r.reason === LOW_USEFULNESS && isObject(r.record))
      .map((r) => ({ id: newId(now), at: now, reason: r.reason, score: r.record.usefulness, record: r.record }));
    if (!fresh.length) return 0;
    const kept = capped([...fresh, ...readGraveyard(file, now)], now);
    save(file, kept);
    return fresh.filter((e) => kept.some((k) => k.id === e.id)).length;
  } catch (err) {
    console.error('[memory] graveyard not written:', errText(err));
    return 0;
  }
}

/**
 * The graveyard as the memory window lists it.
 * @returns {{items: object[], total: number}} item.key = the entry id (never a memory key)
 */
function listGraveyard(file, now) {
  const items = readGraveyard(file, now).map(({ id, at, reason, score, record }) => ({
    key: id,
    at,
    reason,
    usefulness: score,
    project: record.project,
    type: record.type,
    title: record.title,
    body: record.body,
    created: record.created,
  }));
  return { items, total: items.length };
}

/** The entry with this id and the rest of the graveyard, or a reason. */
function findEntry(file, id, now) {
  if (!isEntryId(id)) return { reason: 'bad-key' };
  const entries = readGraveyard(file, now);
  const entry = entries.find((e) => e.id === id);
  return entry ? { entry, rest: entries.filter((e) => e.id !== id) } : { reason: 'not-found' };
}

/**
 * Deletes one entry.
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function removeEntry(file, id, now) {
  const found = findEntry(file, id, now);
  if (!found.entry) return { ok: false, reason: found.reason };
  save(file, found.rest);
  return { ok: true, key: id };
}

/**
 * Brings one entry back as an inbox candidate: written to the mirror as an
 * `observed` memory (memorystore.writeRecord, the path capture writes its
 * candidates through), under a free id, then taken out of the graveyard.
 * `restored` goes to the memory log.
 * @param {{file: string, dir: string, id: string, now: number,
 *   log?: {add: (event: object) => boolean}|null}} opts dir = the mirror folder
 * @returns {{ok: true, key: string}|{ok: false, reason: string}} key = the new memory key
 */
function restoreEntry({ file, dir, id, now, log = null }) {
  const found = findEntry(file, id, now);
  if (!found.entry) return { ok: false, reason: found.reason };
  const { record } = found.entry;
  const taken = new Set(scan(dir).records.map(([k]) => k));
  const free = taken.has(keyOf(record)) ? idFor(record.title, record.project, taken) : record.id;
  if (!free) return { ok: false, reason: 'id-taken' };
  // `supersedes` may only name memories of the project that still exist (the
  // inbox shows them before approval); conflict marks belong to the usefulness
  // scan, never to a candidate.
  const supersedes = record.supersedes.filter((id) => taken.has(`${record.project}/${id}`));
  // Never confirmed from here: it waits in the inbox like any fresh candidate.
  const res = checkRecord({ ...record, id: free, confidence: 'observed', last_verified: null, supersedes, conflicts: [], compatible: [] });
  if (!res.record) return { ok: false, reason: res.error };
  // A hand-edited graveyard must not slip a secret into the synced mirror.
  if (hasSecret(res.record)) return { ok: false, reason: 'secret' };
  const key = keyOf(res.record);
  writeRecord(dir, res.record);
  try {
    save(file, found.rest);
  } catch (err) {
    // The entry stays in the graveyard, so the record must leave the mirror:
    // a second Restore would otherwise put a copy in the inbox.
    removeRecord(dir, key);
    throw err;
  }
  if (log) {
    try {
      log.add({ ev: 'restored', key, type: res.record.type, title: res.record.title, ...(res.record.usefulness !== undefined ? { usefulness: res.record.usefulness } : {}) });
    } catch (err) {
      // The restore itself is done; only the log line is lost.
      console.error('[memory] restored event not logged:', errText(err));
    }
  }
  return { ok: true, key };
}

module.exports = {
  graveyardPath,
  readGraveyard,
  bury,
  listGraveyard,
  removeEntry,
  restoreEntry,
  isEntryId,
  GRAVEYARD_FILE,
  MAX_GRAVEYARD_ENTRIES,
  GRAVEYARD_KEEP_DAYS,
};
