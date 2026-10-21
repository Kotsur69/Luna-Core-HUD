// ============================================================================
// LunaCore - weekly review email (main process)
// ----------------------------------------------------------------------------
// 'Weekly review - <ISO week>' to Mati's own address through src/gmailsend.js
// (the recipient is fixed there; nothing here names one). Plain text plus the
// sender's short HTML part, which is that same text escaped inside <pre> -
// so every model-written string is escaped, never caller HTML.
//
//   afterScheduled(week)  after the Sunday (or catch-up) review: sends when the
//                         Life Settings toggle is on (default on once Gmail is
//                         connected) and that ISO week was never mailed. The
//                         sent mark lives in the week's history entry, so a
//                         restart or a regenerated review never sends twice.
//   sendNow(week)         the 'Email it' button: always sends (a changed review
//                         goes out only this way).
// A failure is saved on the entry (shown on the Week card); the review itself
// is never touched by it.
// ============================================================================

'use strict';

const { reviewText } = require('./weeklyreview');
const { weeklyEmailOn } = require('./mailprefs');

const REASON_RE = /^[a-z0-9-]{1,40}$/;

/** @param {{week:string}} entry a weekly history entry */
const subjectOf = (entry) => `Weekly review - ${entry.week}`;

/**
 * @param {{sender:{status:Function, send:Function}, prefs:{loadPrefs:Function},
 *   store:{get:Function, setMail:Function}, now?:()=>number}} deps
 */
function createWeeklyMail({ sender, prefs, store, now = Date.now }) {
  let busy = false;

  async function deliver(week) {
    const entry = store.get(week);
    if (!entry) return { ok: false, reason: 'not-found' };
    if (busy) return { ok: false, reason: 'busy' };
    busy = true;
    try {
      await sender.send({ subject: subjectOf(entry), text: reviewText(entry), html: true });
      store.setMail(week, { sentAt: now(), error: null });
      return { ok: true };
    } catch (err) {
      const reason = err && typeof err.reason === 'string' && REASON_RE.test(err.reason) ? err.reason : 'failed';
      console.error('[weekly] email failed:', reason, err && err.message);
      try {
        store.setMail(week, { sentAt: null, error: reason });
      } catch (saveErr) {
        console.error('[weekly] could not save the email failure:', saveErr && saveErr.message);
      }
      return { ok: false, reason };
    } finally {
      busy = false;
    }
  }

  /** @returns {Promise<{ok:boolean, reason?:string, skipped?:string}>} never rejects */
  async function afterScheduled(week) {
    try {
      const { connected } = sender.status();
      if (!weeklyEmailOn(prefs.loadPrefs(), connected)) return { ok: true, skipped: 'off' };
      const entry = store.get(week);
      if (entry && entry.mail && entry.mail.sentAt) return { ok: true, skipped: 'sent' };
      return await deliver(week);
    } catch (err) {
      console.error('[weekly] scheduled email failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  }

  /** @returns {Promise<{ok:boolean, reason?:string}>} never rejects */
  async function sendNow(week) {
    try {
      if (!sender.status().connected) return { ok: false, reason: 'gmail-not-connected' };
      return await deliver(week);
    } catch (err) {
      console.error('[weekly] email failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  }

  return { afterScheduled, sendNow };
}

module.exports = { createWeeklyMail, subjectOf };
