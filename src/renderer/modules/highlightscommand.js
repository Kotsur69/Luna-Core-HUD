// ============================================================================
// LunaCore - highlight extractor: pure logic (validation, status mapping)
// ----------------------------------------------------------------------------
// Split out of modules/highlights.js for exactly the reason askcommand.js's
// header documents: highlights.js does module-scope document.getElementById()
// (the overlay's own DOM refs) the moment it is imported, same as every other
// overlay module in this app (libraries.js, ask.js, gitquick.js, palette.js) -
// so it cannot be require()'d from a plain `node --test` run with no DOM.
// Everything here is pure and DOM-free, so it can be.
// ============================================================================

'use strict';

/** Sane default for "keep the last N seconds" when the panel first opens. */
export const DEFAULT_SECONDS = 30;

/**
 * Is `value` usable as the trim window? Mirrors src/highlights.js's own
 * buildTrimArgs() guard (finite, > 0) - kept here too so the renderer can
 * disable the Run button before ever calling the bridge, instead of relying
 * solely on main's own check.
 * @param {*} value
 * @returns {boolean}
 */
export function isValidSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Parses the raw string out of the seconds <input type="number">. Returns
 * NaN (never throws, never silently coerces to 0) for anything unusable -
 * the caller checks the result with isValidSeconds() before trusting it.
 * @param {string} raw
 * @returns {number}
 */
export function parseSecondsInput(raw) {
  // Number('') is 0, not NaN - trim first so a blank/whitespace-only field
  // reports "unusable" instead of silently passing as a valid zero.
  if (typeof raw !== 'string' || !raw.trim()) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Client-side pre-check before runHighlightBatch() is ever called - mirrors
 * openAsk()'s empty-question short-circuit (modules/ask.js's header). Both
 * folders must already be picked and seconds must be a positive number;
 * modules/highlights.js uses this to keep the Run button disabled rather
 * than letting the click reach the bridge with incomplete input.
 * @param {{sourceFolder:?string, outputFolder:?string, seconds:*}} input
 * @returns {{ok:true} | {ok:false, reason:'no-source'|'no-output'|'bad-seconds'}}
 */
export function validateRunInputs({ sourceFolder, outputFolder, seconds } = {}) {
  if (typeof sourceFolder !== 'string' || !sourceFolder) return { ok: false, reason: 'no-source' };
  if (typeof outputFolder !== 'string' || !outputFolder) return { ok: false, reason: 'no-output' };
  if (!isValidSeconds(seconds)) return { ok: false, reason: 'bad-seconds' };
  return { ok: true };
}

/** highlights:progress event names that map to a per-file status row. Events
 *  with no per-file meaning (batch-done/batch-cancelled) are handled by the
 *  caller directly (see modules/highlights.js's onBatchSettled()). */
const STATUS_BY_EVENT = {
  'file-start': 'running',
  'file-done': 'done',
  'file-error': 'error',
  'file-cancelled': 'cancelled',
};

/**
 * Maps a highlights:progress push event's `event` field (src/highlights.js's
 * HighlightBatchJob.emit()) to the status fileStatusRow() renders. Returns
 * null for anything that is not a per-file event.
 * @param {string} eventName
 * @returns {'running'|'done'|'error'|'cancelled'|null}
 */
export function statusForEvent(eventName) {
  return STATUS_BY_EVENT[eventName] || null;
}
