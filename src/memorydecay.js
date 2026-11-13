// ============================================================================
// LunaCore - usefulness decay, the archive and references (main + CLI)
// ----------------------------------------------------------------------------
// A confirmed memory with a usefulness score (src/memoryscan.js) that nobody
// referenced for DECAY_AFTER_DAYS starts losing usefulness: DECAY_PER_STEP
// points for every further DECAY_STEP_DAYS. At zero it moves to the archive:
// `archived` is set to the day it reached zero, and from then on it is left off the
// project card, out of default search, out of God Mode briefs and off the
// review list. Its file stays; the memory window shows it and can restore it.
//
// A reference is a memory being returned by search, opened, verified or
// injected into a God Mode brief. Each one moves `last_used` to today, at most
// once a day per memory: every write is a sync push.
//
// Decay is idempotent: `usefulness_at` records up to which day it was charged,
// so a timer that fires twice a day, or a PC that was off for a month, lowers
// a memory by the same amount.
//
// Only confirmed memories decay. One that still waits in the inbox is Mati's
// to decide (decision 5): it is never archived behind his back.
//
// No Electron here: scripts/luna.js can use the same functions with the app closed.
// ============================================================================

'use strict';

const { splitKey } = require('./memoryrecord');
const { scan, writeRecord } = require('./memorystore');

/** A memory nobody referenced for this long starts losing usefulness. */
const DECAY_AFTER_DAYS = 30;
/** After that, usefulness drops once per this many idle days ... */
const DECAY_STEP_DAYS = 7;
/** ... by this many points (the score runs 0-100). */
const DECAY_PER_STEP = 10;
/** A memory restored from the archive starts again from here. */
const RESTORED_USEFULNESS = 50;
/** `last_used` moves at most this often per memory. */
const REFERENCE_REFRESH_DAYS = 1;
const DECAY_TICK_MS = 6 * 60 * 60 * 1000;
const FIRST_DECAY_MS = 3 * 60 * 1000;
/** Keys the reference recorder remembers as noted today before it starts over. */
const MAX_NOTED = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
const addDays = (date, days) => isoDate(Date.parse(date) + days * DAY_MS);
/** The latest of some YYYY-MM-DD dates (they sort as text). */
const latest = (...dates) => dates.filter(Boolean).sort().pop();

const isArchived = (record) => Boolean(record && record.archived);

/** The last day a memory was known to matter: written, verified or referenced. */
function lastReference(record) {
  return latest(record.created, record.last_verified, record.last_used);
}

/**
 * One memory, one day: the record with its decay applied, or the same object
 * when nothing changes. Pure.
 * @param {object} record a checkRecord() record
 * @param {string} today YYYY-MM-DD
 * @returns {object}
 */
function decayRecord(record, today) {
  if (record.confidence !== 'confirmed' || isArchived(record) || !Number.isInteger(record.usefulness)) return record;
  const graceEnds = addDays(lastReference(record), DECAY_AFTER_DAYS);
  // Charged from the end of the grace period, or from where the last charge
  // (or the scan) left it, whichever is later.
  const from = latest(graceEnds, record.usefulness_at);
  // Never charged past zero: a PC that was off for a month must end where a
  // daily timer would have, archive date included.
  const steps = Math.min(Math.floor(daysBetween(from, today) / DECAY_STEP_DAYS), Math.ceil(record.usefulness / DECAY_PER_STEP));
  const chargedTo = addDays(from, steps * DECAY_STEP_DAYS);
  if (steps < 1) {
    // A score of 0 from the scan: archived once the grace period is over.
    return record.usefulness === 0 && daysBetween(from, today) >= 0 ? { ...record, usefulness_at: from, archived: from } : record;
  }
  const usefulness = Math.max(0, record.usefulness - steps * DECAY_PER_STEP);
  return { ...record, usefulness, usefulness_at: chargedTo, ...(usefulness === 0 ? { archived: chargedTo } : {}) };
}

/**
 * Applies decay to every memory of the mirror.
 * @param {string} dir the mirror folder
 * @param {string} today YYYY-MM-DD
 * @returns {{lowered: string[], archived: string[], failed: number}} keys
 */
function decayAll(dir, today) {
  const lowered = [];
  const archived = [];
  let failed = 0;
  for (const [key, record] of scan(dir).records) {
    const next = decayRecord(record, today);
    if (next === record) continue;
    try {
      writeRecord(dir, next);
      lowered.push(key);
      if (next.archived) archived.push(key);
    } catch (err) {
      // One file that cannot be written must not stop the others from decaying.
      failed++;
      console.error('[memory] decay not written:', errText(err));
    }
  }
  return { lowered, archived, failed };
}

/**
 * Brings a memory back from the archive.
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function restore(dir, key, today) {
  if (!splitKey(key)) return { ok: false, reason: 'bad-key' };
  const found = scan(dir).records.find(([k]) => k === key);
  if (!found) return { ok: false, reason: 'not-found' };
  const { archived, ...record } = found[1];
  if (!archived) return { ok: false, reason: 'not-archived' };
  const usefulness = Math.max(Number.isInteger(record.usefulness) ? record.usefulness : 0, RESTORED_USEFULNESS);
  // Restoring is a reference too: without it, the next tick would archive it again.
  writeRecord(dir, { ...record, usefulness, usefulness_at: today, last_used: today });
  return { ok: true, key };
}

/**
 * Moves `last_used` of the named memories to today.
 * @param {string} dir
 * @param {string[]} keys
 * @param {string} today
 * @returns {string[]} the keys whose file was written
 */
function noteReferences(dir, keys, today) {
  const wanted = new Set(keys.filter((k) => splitKey(k)));
  if (!wanted.size) return [];
  const written = [];
  for (const [key, record] of scan(dir).records) {
    if (!wanted.has(key) || isArchived(record)) continue;
    if (record.last_used && daysBetween(record.last_used, today) < REFERENCE_REFRESH_DAYS) continue;
    try {
      writeRecord(dir, { ...record, last_used: today });
      written.push(key);
    } catch (err) {
      console.error('[memory] reference not written:', errText(err));
    }
  }
  return written;
}

/** The memory keys one memory log event (src/memorylog.js) references. */
function keysOfEvent(event) {
  if (!event || typeof event !== 'object') return [];
  if (event.ev === 'search') return Array.isArray(event.hits) ? event.hits : [];
  if (event.ev === 'get' || event.ev === 'verified') return typeof event.key === 'string' ? [event.key] : [];
  return [];
}

/**
 * References from searches, reads, verifications and God Mode briefs. Each key
 * is looked at once a day; a day of searches costs one scan per new key, not
 * one per search. Never throws: a reference is not worth a failed search.
 * @param {{dir: () => string, now?: () => number, onWritten?: (keys: string[]) => void}} opts
 */
function createReferenceRecorder({ dir, now = Date.now, onWritten = () => {} }) {
  const noted = new Map();
  function note(keys) {
    try {
      const today = isoDate(now());
      const fresh = [...new Set(Array.isArray(keys) ? keys : [])].filter((k) => typeof k === 'string' && noted.get(k) !== today);
      if (!fresh.length) return 0;
      const written = noteReferences(dir(), fresh, today);
      if (noted.size + fresh.length > MAX_NOTED) noted.clear();
      for (const k of fresh) noted.set(k, today);
      if (written.length) onWritten(written);
      return written.length;
    } catch (err) {
      console.error('[memory] references not recorded:', errText(err));
      return 0;
    }
  }
  return { note, fromEvent: (event) => note(keysOfEvent(event)) };
}

/**
 * Decay on a timer, in the main process.
 * @param {{dir: () => string, now?: () => number, onChanged?: (res: object) => void}} opts
 */
function createDecayTimer({ dir, now = Date.now, onChanged = () => {} }) {
  let timer = null;
  let interval = null;
  function tick() {
    try {
      const res = decayAll(dir(), isoDate(now()));
      if (res.lowered.length) onChanged(res);
      return res;
    } catch (err) {
      console.error('[memory] decay failed:', errText(err));
      return null;
    }
  }
  return {
    tick,
    start() {
      timer = setTimeout(tick, FIRST_DECAY_MS);
      interval = setInterval(tick, DECAY_TICK_MS);
      interval.unref();
    },
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
  };
}

module.exports = {
  decayRecord,
  decayAll,
  restore,
  noteReferences,
  keysOfEvent,
  createReferenceRecorder,
  createDecayTimer,
  isArchived,
  lastReference,
  DECAY_AFTER_DAYS,
  DECAY_STEP_DAYS,
  DECAY_PER_STEP,
  RESTORED_USEFULNESS,
  REFERENCE_REFRESH_DAYS,
};
