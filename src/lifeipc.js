// ============================================================================
// LunaCore - Life dashboard IPC (main process)
// ----------------------------------------------------------------------------
// life:budget     -> {ok, summary, budget}  summary = lifebudgetcalc's view of
//                    the current payday period; budget = the editable rows
//                    (income, categories, bills, goals) for the edit forms
// life:budget-do  {op, data} -> same answer after the change
//
// The renderer is untrusted: it names an op and sends a payload, and
// src/lifebudget.js's fixed op table validates all of it. Failures come back
// as fixed reason codes, never raw error text. Purely local - no network, no
// model call. Lives outside main.js (past the file-size guideline); main.js
// only calls registerLifeIpc() once.
// ============================================================================

'use strict';

const store = require('./lifebudget');
const { budgetSummary } = require('./lifebudgetcalc');

// lifebudget.js error message -> reason code the renderer localizes.
const REASONS = {
  'bad op': 'bad-op',
  'bad payload': 'bad-payload',
  'bad amount': 'bad-amount',
  'bad day': 'bad-day',
  'bad date': 'bad-date',
  'bad month': 'bad-month',
  'bad text': 'bad-text',
  'bad id': 'bad-id',
  'bad value': 'bad-value',
  'bad category': 'bad-category',
  'not found': 'not-found',
  'too many': 'too-many',
  unreadable: 'unreadable',
};

// Every write is a full read + rewrite of the file: a renderer stuck in a
// loop must not turn that into a disk-thrashing storm. No person clicks
// twice within this gap.
const MIN_WRITE_GAP_MS = 100;

function reasonOf(err) {
  // fs errors carry a code (EISDIR, EACCES, ENOSPC...): the save failed.
  if (err && typeof err.code === 'string') return 'write-failed';
  return (err && REASONS[err.message]) || 'failed';
}

function view(budget, nowMs) {
  const { income, categories, bills, goals } = budget;
  return { ok: true, summary: budgetSummary(budget, nowMs), budget: { income, categories, bills, goals } };
}

/**
 * @param {{ipcMain: {handle: Function}, file?: string, now?: () => number}} deps
 *   file/now are injectable for tests; the real store path is the default.
 */
function registerLifeIpc({ ipcMain, file, now = Date.now }) {
  let lastWriteAt = -Infinity;

  ipcMain.handle('life:budget', () => {
    try {
      return view(store.loadBudget(file), now());
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });

  ipcMain.handle('life:budget-do', (_event, req) => {
    if (!req || typeof req !== 'object' || typeof req.op !== 'string') return { ok: false, reason: 'bad-op' };
    const at = now();
    if (at - lastWriteAt < MIN_WRITE_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastWriteAt = at;
    try {
      return view(store.apply(req.op, req.data, file, at), at);
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });
}

module.exports = { registerLifeIpc };
