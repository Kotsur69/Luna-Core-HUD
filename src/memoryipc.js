// ============================================================================
// LunaCore - memory inbox IPC (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4. The HUD's inbox panel
// (renderer memoryinbox.js) reviews what capture proposed:
//
//   memory:inbox   ()             -> {ok, items, total, capture}
//   memory:approve (key)          -> {ok, key, removed} | {ok:false, reason}
//   memory:reject  (key)          -> same
//   memory:update  ({key, edits}) -> {ok, key} | {ok:false, reason}
//   memory:changed (push)            the mirror changed: repaint
//
// The renderer names a memory only by its key. src/memoryinbox.js checks the
// key (splitKey: never a path) and refuses anything that is not waiting, so
// these channels cannot touch a confirmed memory. Edited text is rebuilt by
// memoryrecord.checkRecord() like every other record.
// ============================================================================

'use strict';

const { listInbox, approve, reject, update } = require('./memoryinbox');
const { MAX_BODY, MAX_TITLE } = require('./memoryrecord');

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
 *   captureStatus?: () => object|null, now?: () => number}} deps
 *   dir = the mirror folder; onChanged fires after a write (sync soon, repaint)
 */
function registerMemoryIpc({ ipcMain, dir, onChanged = () => {}, captureStatus = () => null, now = Date.now }) {
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
      return { ok: true, ...listInbox(dir()), capture: captureStatus() };
    } catch (err) {
      console.error('[memory] inbox failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('memory:approve', (_event, key) => guarded('approve', () => approve(dir(), keyOf(key), isoDate(now()))));
  ipcMain.handle('memory:reject', (_event, key) => guarded('reject', () => reject(dir(), keyOf(key))));
  ipcMain.handle('memory:update', (_event, req) => {
    const edits = cleanEdits(req && req.edits);
    if (!edits) return { ok: false, reason: 'bad-edits' };
    return guarded('update', () => update(dir(), keyOf(req.key), edits));
  });
}

module.exports = { registerMemoryIpc, cleanEdits };
