// ============================================================================
// LunaCore - the memory log: what capture proposed and what was read (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 5. One append-only file per PC,
// one JSON object per line:
//
//   memory-log.local.jsonl
//   {"at": <ms>, "ev": "capture",  "project", "reason", "kept", "dropped": {"duplicate": 2}}
//   {"at": <ms>, "ev": "proposed", "key", "type", "usefulness"?}
//   {"at": <ms>, "ev": "dropped",  "project", "reason", "type"?, "title"?, "usefulness"?}
//   {"at": <ms>, "ev": "approved" | "edited" | "rejected" | "retired", "key", "type", "title"?, "usefulness"?}
//   {"at": <ms>, "ev": "search",   "project", "hits": ["<key>", ...]}
//   {"at": <ms>, "ev": "get",      "key"}
//   {"at": <ms>, "ev": "verified" | "disputed", "key", "by": "tool" | "user", "note"?, "missing"?}
//
// It answers the questions of section 9 without a guess: which share of the
// captured candidates is approved (per type), how often a memory is found and
// opened, which titles were rejected (they go back to the extractor as "not
// wanted"), which memories a session reported as wrong, and whether the
// extractor's usefulness score predicts the decision (`dropped` = a candidate
// the filter removed before the inbox, with its score).
//
// The log is NOT synced: it describes what happened on this PC. A candidate
// captured here and approved on the other PC counts as proposed here and as
// approved there, so the approval rate is read from decisions (approved over
// approved + rejected), which is right on either PC.
//
// Every line is rebuilt field by field on read: the file can be edited by
// anyone, and a rejected title is later placed in a model prompt.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { TYPES, splitKey, projectFromRepoKey, GLOBAL } = require('./memoryrecord');

const LOG_FILE = 'memory-log.local.jsonl';
/** Past this size the log is trimmed: reads first, then the older half (keptRows). */
const MAX_LOG_BYTES = 1024 * 1024;
/** A trimmed log is at most this big, so the next trim is not one line away. */
const TRIM_TARGET_BYTES = MAX_LOG_BYTES * 0.75;
const MAX_NOTE = 300;
const MAX_TITLE = 200;
const MAX_HITS = 20;
const MAX_MISSING = 20;
const MAX_PATH = 200;
const MAX_REASON = 40;
const MAX_REJECTED_TITLES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const DECISIONS = ['approved', 'edited', 'rejected', 'retired'];
const VERDICTS = ['verified', 'disputed'];
const BY = ['tool', 'user'];

/** Decided candidates are counted per usefulness band to see whether the score predicts approval. */
const USEFULNESS_BANDS = [
  { label: '30-49', min: 30, max: 49 },
  { label: '50-69', min: 50, max: 69 },
  { label: '70-84', min: 70, max: 84 },
  { label: '85-100', min: 85, max: 100 },
];
const MAX_SCORE = 100;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
/** One clean line: no control or invisible characters, no line breaks. */
const line = (v, max) =>
  typeof v === 'string'
    ? v
        .toWellFormed()
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const projectOf = (v) => (v === GLOBAL ? GLOBAL : projectFromRepoKey(v));
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** `{usefulness}` when v is a valid score, else nothing. */
const scored = (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_SCORE ? { usefulness: v } : {});

/** One event rebuilt from untrusted input, or null. */
function cleanEvent(raw) {
  if (!isObject(raw) || !Number.isFinite(raw.at) || raw.at <= 0) return null;
  const { at, ev } = raw;
  const key = splitKey(raw.key) ? raw.key : null;
  const type = TYPES.includes(raw.type) ? raw.type : null;
  if (ev === 'capture') {
    const project = projectOf(raw.project);
    if (!project) return null;
    const dropped = {};
    for (const [reason, n] of Object.entries(isObject(raw.dropped) ? raw.dropped : {}).slice(0, MAX_HITS)) {
      const name = line(reason, MAX_REASON);
      if (name && count(n)) dropped[name] = count(n);
    }
    return { at, ev, project, reason: line(raw.reason, MAX_REASON), kept: count(raw.kept), dropped };
  }
  if (ev === 'proposed') return key && type ? { at, ev, key, type, ...scored(raw.usefulness) } : null;
  if (ev === 'dropped') {
    const project = projectOf(raw.project);
    const reason = line(raw.reason, MAX_REASON);
    if (!project || !reason) return null;
    const title = line(raw.title, MAX_TITLE);
    return { at, ev, project, reason, ...(type ? { type } : {}), ...(title ? { title } : {}), ...scored(raw.usefulness) };
  }
  if (DECISIONS.includes(ev)) {
    if (!key || !type) return null;
    const title = line(raw.title, MAX_TITLE);
    return { at, ev, key, type, ...(title ? { title } : {}), ...scored(raw.usefulness) };
  }
  if (ev === 'search') {
    const hits = Array.isArray(raw.hits) ? raw.hits.filter((k) => splitKey(k)).slice(0, MAX_HITS) : [];
    return { at, ev, project: projectOf(raw.project), hits };
  }
  if (ev === 'get') return key ? { at, ev, key } : null;
  if (VERDICTS.includes(ev)) {
    if (!key || !BY.includes(raw.by)) return null;
    const note = line(raw.note, MAX_NOTE);
    const missing = Array.isArray(raw.missing) ? raw.missing.map((p) => line(p, MAX_PATH)).filter(Boolean).slice(0, MAX_MISSING) : [];
    return { at, ev, key, by: raw.by, ...(note ? { note } : {}), ...(missing.length ? { missing } : {}) };
  }
  return null;
}

/** Every valid event of the log, oldest first. A missing file is an empty log. */
function readLog(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const row of text.split('\n')) {
    if (!row.trim()) continue;
    try {
      const event = cleanEvent(JSON.parse(row));
      if (event) events.push(event);
    } catch {
      // A torn or hand-broken line: the rest of the log still counts.
    }
  }
  return events;
}

/** A line that only counts a read. Reads are many and cheap to lose; decisions and reports are not. */
const USE_ROW_RE = /"ev":"(search|get)"/;
const bytesOf = (rows) => rows.reduce((sum, row) => sum + Buffer.byteLength(row, 'utf8') + 1, 0);

/**
 * The rows a log past its limit keeps. Reads go first, oldest first: a session
 * that searches in a loop must not push a report or a decision out of the log.
 * Only when the rest alone is too big does its older half go too.
 */
function keptRows(rows) {
  const isUse = rows.map((row) => USE_ROW_RE.test(row));
  const uses = isUse.filter(Boolean).length;
  let dropUses = Math.ceil(uses / 2);
  let kept = rows.filter((_, i) => !isUse[i] || dropUses-- <= 0);
  if (bytesOf(kept) > TRIM_TARGET_BYTES) kept = kept.filter((row) => !USE_ROW_RE.test(row));
  while (bytesOf(kept) > TRIM_TARGET_BYTES && kept.length > 1) kept = kept.slice(Math.ceil(kept.length / 2));
  return kept;
}

/** Shrinks a log that grew past its limit. */
function trim(file) {
  if (fs.statSync(file).size <= MAX_LOG_BYTES) return;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${keptRows(rows).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * @param {string} file the log file (logPath(configDir))
 * @param {{now?: () => number}} [opts]
 * @returns {{add: (event: object) => boolean, read: () => object[]}}
 *   add never throws: the log must not fail an approval, a capture or a search
 */
function createLog(file, { now = Date.now } = {}) {
  return {
    add(raw) {
      try {
        const event = cleanEvent({ ...raw, at: now() });
        if (!event) return false;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
      } catch (err) {
        console.error('[memory] log not written:', errText(err));
        return false;
      }
      try {
        trim(file);
      } catch (err) {
        // The event is on disk: a log that could not be shortened is tried again on the next add.
        console.error('[memory] log not trimmed:', errText(err));
      }
      return true;
    },
    /** A log that cannot be read is an empty one: statistics are never worth a failure. */
    read() {
      try {
        return readLog(file);
      } catch (err) {
        console.error('[memory] log unreadable:', errText(err));
        return [];
      }
    },
  };
}

const logPath = (configDir) => path.join(configDir, LOG_FILE);

/**
 * The log line of an inbox decision, the same from the app and the CLI. A
 * rejected title goes back to the extractor as "not wanted"; the score feeds
 * the per-band calibration of captureStats.
 * @param {'approved'|'edited'|'rejected'} ev
 * @param {{project: string, id: string, type: string, title: string, usefulness?: number}} record
 */
const decisionEvent = (ev, record) => ({
  ev,
  key: `${record.project}/${record.id}`,
  type: record.type,
  ...(ev === 'rejected' ? { title: record.title } : {}),
  ...scored(record.usefulness),
});
const projectOfKey = (key) => splitKey(key).project;

const emptyCounts = () => ({ proposed: 0, approved: 0, rejected: 0, edited: 0 });
const emptyBands = () => USEFULNESS_BANDS.map(({ label }) => ({ label, approved: 0, rejected: 0 }));
/** Approved over decided, 0 to 1, or null when nothing was decided. */
const rateOf = ({ approved, rejected }) => (approved + rejected ? approved / (approved + rejected) : null);

/**
 * What capture proposed and what became of it.
 * @param {object[]} events readLog()
 * @param {{since?: number, project?: string|null}} [opts] since = ms; project = only this one
 * @returns {{captures: number, proposed: number, approved: number, rejected: number, edited: number,
 *   rate: number|null, dropped: object, byType: object,
 *   bands: {label: string, approved: number, rejected: number}[], under: {approved: number, rejected: number},
 *   unscored: {approved: number, rejected: number}}}
 *   edited = approved memories that were edited first; rate = approved / (approved + rejected);
 *   bands = decisions per usefulness band (USEFULNESS_BANDS); under = scored below the lowest band
 *   (a hand-edited file, or a floor raised later); unscored = decisions without a score
 */
function captureStats(events, { since = 0, project = null } = {}) {
  const total = { captures: 0, ...emptyCounts() };
  const byType = {};
  const dropped = {};
  const editedKeys = new Set();
  const bands = emptyBands();
  const under = { approved: 0, rejected: 0 };
  const unscored = { approved: 0, rejected: 0 };
  const decide = (usefulness, field) => {
    if (usefulness === undefined) return void unscored[field]++;
    const i = USEFULNESS_BANDS.findIndex((b) => usefulness >= b.min && usefulness <= b.max);
    if (i < 0) under[field]++;
    else bands[i] = { ...bands[i], [field]: bands[i][field] + 1 };
  };
  const bump = (type, field) => {
    byType[type] = byType[type] || emptyCounts();
    byType[type][field]++;
    total[field]++;
  };
  for (const e of events) {
    // An edit may be older than the window its approval falls in.
    if (e.ev === 'edited') editedKeys.add(e.key);
    if (e.at < since) continue;
    if (project && (e.ev === 'capture' ? e.project : e.key ? projectOfKey(e.key) : null) !== project) continue;
    if (e.ev === 'capture') {
      total.captures++;
      for (const [reason, n] of Object.entries(e.dropped)) dropped[reason] = (dropped[reason] || 0) + n;
    } else if (e.ev === 'proposed') {
      bump(e.type, e.ev);
    } else if (e.ev === 'rejected') {
      bump(e.type, e.ev);
      decide(e.usefulness, e.ev);
    } else if (e.ev === 'approved') {
      bump(e.type, 'approved');
      decide(e.usefulness, 'approved');
      if (editedKeys.has(e.key)) bump(e.type, 'edited');
    }
  }
  for (const counts of Object.values(byType)) counts.rate = rateOf(counts);
  return { ...total, rate: rateOf(total), dropped, byType, bands, under, unscored };
}

/**
 * How often each memory came back from a search and was opened.
 * @returns {Map<string, {found: number, opened: number, last: number}>}
 */
function usage(events, { since = 0 } = {}) {
  const byKey = new Map();
  const touch = (key, field, at) => {
    const u = byKey.get(key) || { found: 0, opened: 0, last: 0 };
    byKey.set(key, { ...u, [field]: u[field] + 1, last: Math.max(u.last, at) });
  };
  for (const e of events) {
    if (e.at < since) continue;
    if (e.ev === 'search') for (const key of e.hits) touch(key, 'found', e.at);
    else if (e.ev === 'get') touch(e.key, 'opened', e.at);
  }
  return byKey;
}

/** The titles last rejected for a project (and for global), newest first, without repeats. */
function rejectedTitles(events, project, max = MAX_REJECTED_TITLES) {
  const titles = [];
  for (let i = events.length - 1; i >= 0 && titles.length < max; i--) {
    const e = events[i];
    if (e.ev !== 'rejected' || !e.title) continue;
    const of = projectOfKey(e.key);
    if ((of === project || of === GLOBAL) && !titles.includes(e.title)) titles.push(e.title);
  }
  return titles;
}

/**
 * The memories a session reported as wrong and nobody has looked at since.
 * The user's own "still true" settles a report; a session's "it held" does not.
 * @returns {Map<string, {at: number, note: string}>}
 */
function openDisputes(events) {
  const open = new Map();
  for (const e of events) {
    if (e.ev === 'disputed') open.set(e.key, { at: e.at, note: e.note || '' });
    else if ((e.ev === 'verified' && e.by === 'user') || e.ev === 'retired' || e.ev === 'rejected') open.delete(e.key);
  }
  return open;
}

/**
 * Per memory, the missing files the user has already seen and accepted with
 * "still true": they are not flagged a second time.
 * @returns {Map<string, Set<string>>}
 */
function acceptedMissing(events) {
  const accepted = new Map();
  for (const e of events) {
    if (e.ev === 'verified' && e.by === 'user') accepted.set(e.key, new Set(e.missing || []));
  }
  return accepted;
}

module.exports = {
  createLog,
  readLog,
  logPath,
  cleanEvent,
  decisionEvent,
  captureStats,
  usage,
  rejectedTitles,
  openDisputes,
  acceptedMissing,
  LOG_FILE,
  MAX_LOG_BYTES,
  MAX_NOTE,
  DAY_MS,
  USEFULNESS_BANDS,
};
