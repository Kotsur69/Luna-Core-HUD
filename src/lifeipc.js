// ============================================================================
// LunaCore - Life dashboard IPC (main process)
// ----------------------------------------------------------------------------
// life:budget     {month?} -> {ok, summary, budget}  summary = lifebudgetcalc's
//                    view of the payday period starting in `month` ('YYYY-MM',
//                    default the current one); budget = the editable rows
//                    (income, categories, bills, goals) for the edit forms
// life:budget-do  {op, data, month?} -> same answer after the change, plus
//                    `created` (the new row id) for addExpense / addDeposit
// life:body        {force?} -> {ok, connected, body?}  YAZIO numbers (today +
//                    7 days); body is absent while not connected
// life:body-connect {email, password} -> {ok, persisted} | {ok:false, reason}
// life:body-disconnect -> {ok}  forgets the stored YAZIO login
//
// The renderer is untrusted: it names an op and sends a payload, and
// src/lifebudget.js's fixed op table validates all of it. Failures come back
// as fixed reason codes, never raw error text. The budget is shared with the
// other PCs through the Syncthing folder (src/lifesync.js: a read pulls their
// changes first, a write publishes soon after); only life:body* talk to the
// network (YAZIO, via src/lifeyazio.js). No model call. Lives outside main.js (past
// the file-size guideline); main.js only calls registerLifeIpc() once.
// ============================================================================

'use strict';

const store = require('./lifebudget');
const { budgetSummary } = require('./lifebudgetcalc');
const { createYazio, MAX_EMAIL: MAX_EMAIL_LEN, MAX_PASSWORD: MAX_PASSWORD_LEN } = require('./lifeyazio');

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
// Ops that append one row (lifebudget.js always appends at the end).
const CREATES = { addExpense: 'expenses', addDeposit: 'deposits' };
// A forced YAZIO refresh is 8 requests: a looping renderer must not hammer
// an unofficial API with Mati's account. Unforced reads come from the cache.
const MIN_FORCE_GAP_MS = 15 * 1000;
const MIN_CONNECT_GAP_MS = 3 * 1000;
const YAZIO_REASONS = new Set(['not-connected', 'bad-login', 'network', 'rate-limited', 'api-changed']);

function reasonOf(err) {
  // fs errors carry a code (EISDIR, EACCES, ENOSPC...): the save failed.
  if (err && typeof err.code === 'string') return 'write-failed';
  return (err && REASONS[err.message]) || 'failed';
}

// The viewed period: a valid month at most this far from today, else the
// current one. Anything malformed silently falls back - it is only a view.
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const VIEW_WINDOW_MONTHS = 36;

function viewMonth(req, nowMs) {
  const m = req && typeof req === 'object' && typeof req.month === 'string' ? MONTH_RE.exec(req.month) : null;
  if (!m) return undefined;
  const now = new Date(nowMs);
  const offset = (Number(m[1]) - now.getFullYear()) * 12 + (Number(m[2]) - 1 - now.getMonth());
  return Math.abs(offset) <= VIEW_WINDOW_MONTHS ? req.month : undefined;
}

function view(budget, nowMs, month) {
  const { income, categories, bills, goals } = budget;
  return { ok: true, summary: budgetSummary(budget, nowMs, month), budget: { income, categories, bills, goals } };
}

function yazioReason(err) {
  const reason = err && err.reason;
  if (YAZIO_REASONS.has(reason)) return reason;
  console.error('[life] yazio failed:', (err && (err.code || err.name)) || 'error');
  return 'failed';
}

/**
 * @param {{ipcMain: {handle: Function}, file?: string, now?: () => number,
 *   yazio?: object, sync?: {fresh: Function, soon: Function} | null}} deps
 *   file/now/yazio are injectable for tests; the real store path and a real
 *   YAZIO client are the defaults. sync = startLifeSync() in the app, none in tests.
 */
function registerLifeIpc({ ipcMain, file, now = Date.now, yazio = createYazio(), sync = null }) {
  let lastWriteAt = -Infinity;
  let lastForceAt = -Infinity;
  let lastConnectAt = -Infinity;

  ipcMain.handle('life:budget', (_event, req) => {
    try {
      if (sync) sync.fresh();
      const at = now();
      return view(store.loadBudget(file), at, viewMonth(req, at));
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
      const next = store.apply(req.op, req.data, file, at);
      if (sync) sync.soon();
      // A create answers its new row id, so the renderer can offer Undo.
      const rows = Object.hasOwn(CREATES, req.op) ? next[CREATES[req.op]] : null;
      const created = rows && rows.length ? rows[rows.length - 1].id : undefined;
      return { ...view(next, at, viewMonth(req, at)), created };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });

  ipcMain.handle('life:body', async (_event, req) => {
    if (!yazio.status().connected) return { ok: true, connected: false };
    let force = Boolean(req && typeof req === 'object' && req.force === true);
    if (force) {
      const at = now();
      // Too soon: answer from the cache instead of refusing outright.
      if (at - lastForceAt < MIN_FORCE_GAP_MS) force = false;
      else lastForceAt = at;
    }
    try {
      return { ok: true, connected: true, body: await yazio.body({ force }) };
    } catch (err) {
      return { ok: false, connected: true, reason: yazioReason(err) };
    }
  });

  ipcMain.handle('life:body-connect', async (_event, req) => {
    // Lengths are bounded before any string work (validCreds re-checks after the trim).
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.email !== 'string' ||
      typeof req.password !== 'string' ||
      req.email.length > MAX_EMAIL_LEN ||
      req.password.length > MAX_PASSWORD_LEN
    ) {
      return { ok: false, reason: 'bad-login' };
    }
    const at = now();
    if (at - lastConnectAt < MIN_CONNECT_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastConnectAt = at;
    try {
      const { persisted } = await yazio.connect({ email: req.email.trim(), password: req.password });
      return { ok: true, persisted };
    } catch (err) {
      return { ok: false, reason: yazioReason(err) };
    }
  });

  ipcMain.handle('life:body-disconnect', () => {
    yazio.disconnect();
    return { ok: true };
  });
}

module.exports = { registerLifeIpc };
