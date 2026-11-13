// ============================================================================
// LunaCore - memory inbox IPC (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4. The HUD's inbox panel
// (renderer memoryinbox.js) reviews what capture proposed:
//
//   memory:inbox   ()             -> {ok, items, total, conflicts: {items, total}, capture}
//   memory:approve (key)          -> {ok, key, removed} | {ok:false, reason}
//   memory:reject  (key)          -> same
//   memory:update  ({key, edits}) -> {ok, key} | {ok:false, reason}
//   memory:make-global (key)      -> {ok, key} | {ok:false, reason}   key = the new global key
//   memory:changed (push)            the mirror changed: repaint
//
// Phase 5, the review list (src/memoryreview.js): confirmed memories that are
// stale, name a file that is gone, or were reported wrong by a session.
//
//   memory:review  ()             -> {ok, items, total}
//   memory:verify  (key)          -> {ok, key} | {ok:false, reason}   "still true"
//   memory:retire  (key)          -> same                             deleted on every PC
//   Both refuse a memory that is not on the review list (`not-flagged`).
//
// memory:inbox also carries `stats`: what capture proposed in the last week
// and what was approved (src/memorylog.js). Every decision is written to that log.
//
// The renderer names a memory only by its key. src/memoryinbox.js checks the
// key (splitKey: never a path) and refuses anything that is not waiting, so
// these channels cannot touch a confirmed memory. Edited text is rebuilt by
// memoryrecord.checkRecord() like every other record.
// ============================================================================

'use strict';

const { listInbox, approve, reject, update, makeGlobal } = require('./memoryinbox');
const { MAX_BODY, MAX_TITLE } = require('./memoryrecord');
const { scan } = require('./memorystore');
const { reviewList, verify, retire, findConfirmed } = require('./memoryreview');
const { captureStats, DAY_MS } = require('./memorylog');
const { listConflicts } = require('./memoryconflict');

/** The window of the approval-rate line under the inbox. */
const STATS_DAYS = 7;

const MAX_KEY_CHARS = 200;
const EDIT_LIMITS = { title: MAX_TITLE * 2, body: MAX_BODY * 2, type: 20, area: 40 };

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const keyOf = (v) => (typeof v === 'string' && v.length <= MAX_KEY_CHARS ? v : '');

/** Only the four editable fields, strings of a sane length; anything else is dropped. */
function cleanEdits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const edits = {};
  for (const [field, max] of Object.entries(EDIT_LIMITS)) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > max) return null;
    edits[field] = value;
  }
  return edits;
}

/**
 * @param {{ipcMain: object, dir: () => string, onChanged?: () => void,
 *   captureStatus?: () => object|null, now?: () => number,
 *   log?: {add: Function, read: Function}|null, roots?: () => object}} deps
 *   dir = the mirror folder; onChanged fires after a write (sync soon, repaint);
 *   log = the memory log; roots = {<project>: its folder on this PC}, for the anchor check
 */
function registerMemoryIpc({ ipcMain, dir, onChanged = () => {}, captureStatus = () => null, now = Date.now, log = null, roots = () => ({}) }) {
  /** Writes an inbox decision to the memory log. Only a rejected title is kept: it goes back to the extractor. */
  const decided = (ev, record) => {
    if (log) log.add({ ev, key: `${record.project}/${record.id}`, type: record.type, ...(ev === 'rejected' ? { title: record.title } : {}) });
  };
  const events = () => (log ? log.read() : []);
  /** The anchor check walks folders main named: a failure there must not hide the list. */
  const knownRoots = () => {
    try {
      return roots() || {};
    } catch (err) {
      console.error('[memory] project folders unavailable:', errText(err));
      return {};
    }
  };
  /** A write: never throws to the renderer, and tells main when files changed. */
  const guarded = (label, fn) => {
    try {
      const res = fn();
      if (res.ok) onChanged();
      return res;
    } catch (err) {
      console.error(`[memory] ${label} failed:`, errText(err));
      return { ok: false, reason: 'failed' };
    }
  };

  ipcMain.handle('memory:inbox', () => {
    try {
      const { captures, proposed, approved, rejected, edited, rate } = captureStats(events(), { since: now() - STATS_DAYS * DAY_MS });
      return {
        ok: true,
        ...listInbox(dir()),
        // Memories that contradict each other wait here too (src/memoryconflict.js).
        conflicts: listConflicts(scan(dir()).records, { events: events() }),
        capture: captureStatus(),
        stats: { days: STATS_DAYS, captures, proposed, approved, rejected, edited, rate },
      };
    } catch (err) {
      console.error('[memory] inbox failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('memory:approve', (_event, key) => guarded('approve', () => approve(dir(), keyOf(key), isoDate(now()), decided)));
  ipcMain.handle('memory:reject', (_event, key) => guarded('reject', () => reject(dir(), keyOf(key), decided)));
  ipcMain.handle('memory:update', (_event, req) => {
    const edits = cleanEdits(req && req.edits);
    if (!edits) return { ok: false, reason: 'bad-edits' };
    return guarded('update', () => update(dir(), keyOf(req.key), edits, decided));
  });
  ipcMain.handle('memory:make-global', (_event, key) => guarded('make-global', () => makeGlobal(dir(), keyOf(key))));

  ipcMain.handle('memory:review', () => {
    try {
      return { ok: true, ...reviewList({ records: scan(dir()).records, today: isoDate(now()), events: events(), roots: knownRoots() }) };
    } catch (err) {
      console.error('[memory] review failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  /**
   * The renderer may settle only what the review list shows: these channels
   * are no way to delete or re-date an arbitrary confirmed memory.
   * @returns {{ok: false, reason: string}|null} null = the key is on the list
   */
  const refusal = (key, knownHere) => {
    const found = findConfirmed(dir(), key);
    if (!found.record) return { ok: false, reason: found.reason };
    const { items } = reviewList({ records: scan(dir()).records, today: isoDate(now()), events: events(), roots: knownHere });
    return items.some((item) => item.key === key) ? null : { ok: false, reason: 'not-flagged' };
  };
  ipcMain.handle('memory:verify', (_event, key) =>
    guarded('verify', () => {
      const knownHere = knownRoots();
      return refusal(keyOf(key), knownHere) || verify(dir(), keyOf(key), isoDate(now()), { log, roots: knownHere });
    }),
  );
  ipcMain.handle('memory:retire', (_event, key) => guarded('retire', () => refusal(keyOf(key), knownRoots()) || retire(dir(), keyOf(key), { log })));
}

/**
 * How many confirmed memories are on the review list (the hub counts them
 * with the inbox). Never throws: a count is not worth a failed hub tick.
 * @param {{dir: string, today: string, events?: object[], roots?: object}} ctx
 */
function reviewCount({ dir, today, events = [], roots = {} }) {
  try {
    return reviewList({ records: scan(dir).records, today, events, roots }).total;
  } catch (err) {
    console.error('[memory] review count failed:', errText(err));
    return 0;
  }
}

module.exports = { registerMemoryIpc, cleanEdits, reviewCount, STATS_DAYS };
