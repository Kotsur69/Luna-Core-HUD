// ============================================================================
// LunaCore - God Mode run emails that wait for Gmail (main process)
// ----------------------------------------------------------------------------
// The end-of-run email (godmodemail.js) can fail for a reason that goes away
// on its own: Gmail not connected yet, rate-limited, busy, the network. Such
// a run is marked "email pending" here, in mail-state.local.json under
// `godmodePending`, with the compact summary the email is built from. When
// Gmail becomes connected (mail:connect) or on the next start, flush() sends
// the pending ones once: oldest first, at most MAX_PER_FLUSH, each run at
// most once (it leaves the list BEFORE the send), with the same report text
// and the same HTML attachment (reportmail.readRunHtml) as the first try.
//
// resend() is the board's "Resend report email": one run, now, past the
// dedupe (godmodemail's force), with the summary main hands in or the one
// stored with the pending entry.
//
// The file is on disk, so every entry is validated on load (normalizePending).
// ============================================================================

'use strict';

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
// Failures worth a later try; anything else (auth, scope, a bad input) is not.
const TRANSIENT_REASONS = new Set(['gmail-not-connected', 'rate-limited', 'busy', 'gmail-network', 'gmail-timeout']);
const NOT_CONNECTED = 'gmail-not-connected';
const MAX_PENDING = 20;
const MAX_PER_FLUSH = 3;
const MAX_ITEMS = 50;
const MODES = new Set(['pr', 'merge', 'branches']);
const STATE_RE = /^[a-z]{1,24}$/;
const REASON_RE = /^[a-z][a-z-]{0,39}$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL_RE = new RegExp('[\\x00-\\x1f\\x7f\\u2028\\u2029]+', 'g');
const clean = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_RE, ' ').trim().slice(0, max) : '');
const orNull = (v, max) => clean(v, max) || null;
const count = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(9999, v)) : 0);
const isRunId = (v) => typeof v === 'string' && RUN_ID_RE.test(v);

/** Whether a run email failure reason is worth a later automatic try. */
const isTransient = (reason) => TRANSIENT_REASONS.has(reason);

/**
 * Why a godmodemail.onReport result is a failure, or null when it is not
 * (sent, a duplicate, switched off).
 * @param {{sent?:boolean, skipped?:string, error?:string}|null|undefined} res
 */
function failureOf(res) {
  if (!res || res.sent) return null;
  if (typeof res.error === 'string') return REASON_RE.test(res.error) ? res.error : 'gmail-failed';
  return res.skipped === 'not-connected' ? NOT_CONNECTED : null;
}

/**
 * The part of a run summary (godmodesnapshot.runEntry + integrationError)
 * that godmodemail.buildRunEmail reads, cleaned and capped.
 * @param {unknown} raw
 * @returns {object|null}
 */
function cleanSummary(raw) {
  if (!isObject(raw)) return null;
  return {
    repoName: clean(raw.repoName, 100),
    integrationMode: MODES.has(raw.integrationMode) ? raw.integrationMode : 'branches',
    integrationState: typeof raw.integrationState === 'string' && STATE_RE.test(raw.integrationState) ? raw.integrationState : 'idle',
    integrationError: orNull(raw.integrationError, 300),
    pushed: count(raw.pushed),
    merged: count(raw.merged),
    total: count(raw.total),
    packages: (Array.isArray(raw.packages) ? raw.packages : [])
      .filter(isObject)
      .slice(0, MAX_ITEMS)
      .map((p) => ({
        id: clean(p.id, 64),
        title: clean(p.title, 120),
        state: clean(p.state, 24),
        reason: orNull(p.reason, 300),
        prUrl: orNull(p.prUrl, 300),
      })),
    approvalSuggestions: (Array.isArray(raw.approvalSuggestions) ? raw.approvalSuggestions : [])
      .filter((s) => typeof s === 'string')
      .slice(0, MAX_ITEMS)
      .map((s) => clean(s, 200)),
  };
}

/**
 * The stored pending list, validated: oldest first, one entry per run, at
 * most MAX_PENDING (the oldest dropped).
 * @param {unknown} raw
 * @returns {Array<{id:string, at:number, reason:string, summary:object}>}
 */
function normalizePending(raw) {
  const byId = new Map();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!isObject(e) || !isRunId(e.id) || !Number.isFinite(e.at)) continue;
    const summary = cleanSummary(e.summary);
    if (!summary) continue;
    byId.set(e.id, { id: e.id, at: e.at, reason: isTransient(e.reason) ? e.reason : 'gmail-failed', summary });
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_PENDING);
}

/**
 * @param {{
 *   prefs: {loadState: () => object, updateState: (fn: (s:object) => object) => object},
 *   send: (runId:string, text:string, summary:object, opts?:{force?:boolean}) =>
 *     Promise<{sent:boolean, skipped?:string, error?:string}>,
 *   readReport: (runId:string) => string|null,
 *   connected: () => boolean,
 *   onResult?: (runId:string, res:{sent:boolean, reason:string|null}) => void,
 *   now?: () => number,
 * }} deps
 *   send: godmodemail onReport; readReport: the run's markdown report;
 *   onResult: a later send's outcome (flush / resend), for the board
 */
function createPendingRunMail(deps) {
  const now = deps.now || Date.now;
  const onResult = (runId, res) => {
    if (!deps.onResult) return;
    try {
      deps.onResult(runId, res);
    } catch (err) {
      console.error('[godmodemail] pending result not applied:', err && err.message);
    }
  };
  let flushing = false;

  const list = () => normalizePending(deps.prefs.loadState().godmodePending);
  const save = (fn) => deps.prefs.updateState((s) => ({ ...s, godmodePending: fn(normalizePending(s.godmodePending)) }));
  const get = (runId) => list().find((e) => e.id === runId) || null;

  /**
   * Marks a run's email pending. Only a transient reason counts.
   * @returns {boolean} whether it was marked
   */
  function mark(runId, summary, reason) {
    const summaryClean = cleanSummary(summary);
    if (!isRunId(runId) || !summaryClean || !isTransient(reason)) return false;
    save((items) => [...items.filter((e) => e.id !== runId), { id: runId, at: now(), reason, summary: summaryClean }]);
    return true;
  }

  /** Clears a run's pending flag (sent, or given up on). */
  function drop(runId) {
    if (!get(runId)) return;
    save((items) => items.filter((e) => e.id !== runId));
  }

  /** One send that never rejects: a throw reads as gmail-failed. */
  async function trySend(runId, text, summary, opts) {
    try {
      return (await deps.send(runId, text, summary, opts)) || { sent: false, error: 'gmail-failed' };
    } catch (err) {
      return { sent: false, error: (err && err.reason) || 'gmail-failed' };
    }
  }

  /**
   * The end-of-run email, first try (orchestraFinalize's onReport). A
   * transient failure marks the run pending; the result says so.
   * @returns {Promise<{sent:boolean, skipped?:string, error?:string, pending?:boolean}>} never rejects
   */
  async function report(runId, text, summary) {
    const res = await trySend(runId, text, summary);
    const reason = failureOf(res);
    let marked = false;
    try {
      if (reason) marked = mark(runId, summary, reason);
      else if (res.sent) drop(runId);
    } catch (err) {
      console.error('[godmodemail] pending state not saved:', err && err.message);
    }
    return marked ? { ...res, pending: true } : res;
  }

  /**
   * Sends the pending run emails once, oldest first, at most MAX_PER_FLUSH.
   * Nothing happens while Gmail is not connected - they stay pending.
   * @returns {Promise<Array<{id:string, sent:boolean, reason:string|null}>>} never rejects
   */
  async function flush() {
    if (flushing) return [];
    flushing = true;
    try {
      if (!deps.connected()) return [];
      const batch = list().slice(0, MAX_PER_FLUSH);
      // Each run is tried at most once: it leaves the list before its send.
      if (batch.length) save((items) => items.filter((e) => !batch.some((b) => b.id === e.id)));
      const results = [];
      for (const entry of batch) {
        const text = deps.readReport(entry.id);
        const res = text ? await trySend(entry.id, text, entry.summary) : { sent: false, error: 'no-report' };
        // A duplicate means the email already went out (a Resend); "off" is Mati's choice.
        const sent = !!(res.sent || res.skipped === 'duplicate');
        const reason = sent ? null : failureOf(res) || res.skipped || 'gmail-failed';
        results.push({ id: entry.id, sent, reason });
        onResult(entry.id, { sent, reason });
      }
      return results;
    } catch (err) {
      console.error('[godmodemail] pending run emails failed:', err && err.message);
      return [];
    } finally {
      flushing = false;
    }
  }

  /**
   * "Resend report email": this run, now, past the dedupe. `summary` is the
   * current run's (main builds it); a run that is not on the board any more
   * falls back to its pending entry.
   * @returns {Promise<{ok:boolean, reason?:string}>} never rejects
   */
  async function resend(runId, summary) {
    if (!isRunId(runId)) return { ok: false, reason: 'badId' };
    try {
      const entry = get(runId);
      const use = cleanSummary(summary) || (entry && entry.summary);
      if (!use) return { ok: false, reason: 'unknownRun' };
      if (!deps.connected()) return { ok: false, reason: NOT_CONNECTED };
      const text = deps.readReport(runId);
      if (!text) return { ok: false, reason: 'no-report' };
      const res = await trySend(runId, text, use, { force: true });
      if (res.sent) {
        drop(runId);
        onResult(runId, { sent: true, reason: null });
        return { ok: true };
      }
      return { ok: false, reason: failureOf(res) || res.skipped || 'gmail-failed' };
    } catch (err) {
      console.error('[godmodemail] resend failed:', err && err.message);
      return { ok: false, reason: 'gmail-failed' };
    }
  }

  return { mark, drop, get, list, report, flush, resend };
}

module.exports = {
  createPendingRunMail,
  normalizePending,
  cleanSummary,
  failureOf,
  isTransient,
  TRANSIENT_REASONS,
  MAX_PER_FLUSH,
  MAX_PENDING,
};
