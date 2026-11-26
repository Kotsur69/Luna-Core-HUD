// ============================================================================
// LunaCore - the console window of one Unity playtest (Unity Pipeline)
// ----------------------------------------------------------------------------
// The editor's console buffer outlives a playtest: errors other tools logged
// earlier in the same editor session (a failed `prefab create`, an asset that
// could not be created) sit in it next to the game's own. Counting the whole
// buffer blamed the game for them (iteration evidence said {error 6, warn 9}
// while the editor's groundTruth said 0 console errors).
//
// So the adapter takes the console cursor when the playtest starts, before
// play mode, and everything after that reads only entries newer than it:
//
//   `console get` answer   {entries:[{seq, level, logType, message, stackTrace,
//                           seeded?}], cursor, session, returned, dropped,
//                           reset, counts, groundTruth}   (com.unity.pipeline 1.0.0)
//   window                 {session, cursor, startedAt} - the cursor is the
//                           highest seq the buffer held at the start
//   read                   `console get --since <cursor> --since-session <session>`;
//                           the entries are filtered again here (seq > cursor),
//                           so an editor that ignores `since` cannot leak old ones
//   new session            the editor restarted or dropped its buffer (another
//                           session id, or reset:true): sequence numbers began
//                           again after the start, so every entry of the new
//                           session belongs to the playtest - a fresh window
//
// The buffer-wide `counts` of the answer are NOT the window's: they are
// replaced by counts over the window's entries. groundTruth (compile state,
// the Editor console's own totals) is kept as it is, under its own name.
// ============================================================================

'use strict';

const CONSOLE_COMMAND = 'console get';
const CONSOLE_TAIL = 100;
// Minimum severity: warnings and errors ('warning' is accepted as 'warn').
const CONSOLE_LEVEL = 'warning';
// A capture session id: a GUID in "N" format (32 hex digits); a little slack for other formats.
const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What a window read covers: entries after the start; a fresh session (the
 * editor's capture restarted); the same session but a cursor the editor could
 * not honour (it returned its tail: counted as a fresh window too); or the
 * whole buffer (no window).
 */
const WINDOW_SCOPE = Object.freeze({
  sinceStart: 'since-start',
  freshSession: 'fresh-session',
  cursorReset: 'cursor-reset',
  wholeBuffer: 'whole-buffer',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isCursor = (v) => Number.isSafeInteger(v) && v >= -1;

/**
 * A console window {session, cursor, startedAt}; throws unless session and
 * cursor are usable (they go back to the editor as parameters).
 */
function consoleWindow({ session, cursor, startedAt = null }) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) throw new Error('the Unity console session id is not usable');
  if (!isCursor(cursor)) throw new Error('the Unity console cursor must be a whole number');
  return { session, cursor, startedAt: typeof startedAt === 'string' ? startedAt : null };
}

/**
 * The window a `console get` answer opens at the playtest start. Without a
 * usable cursor and session the window is null and `reason` says why (the
 * reads then cover the whole buffer and say so).
 * @param {unknown} answer
 * @param {string} startedAt ISO time of the start
 * @returns {{window:{session:string, cursor:number, startedAt:string|null}|null, reason:string|null}}
 */
function consoleWindowOf(answer, startedAt) {
  if (!isObj(answer)) return { window: null, reason: 'the console answer is not an object' };
  if (answer.session === undefined && answer.cursor === undefined) return { window: null, reason: 'the console answer has no cursor or session' };
  try {
    return { window: consoleWindow({ session: answer.session, cursor: answer.cursor, startedAt }), reason: null };
  } catch (err) {
    return { window: null, reason: err.message };
  }
}

/**
 * The Pipeline `console get` call: warnings and errors after `window`, or the
 * buffer's tail without one.
 * @param {{session:string, cursor:number}|null} [window]
 * @returns {[string, object]}
 */
function consoleCall(window = null) {
  const parameters = { tail: CONSOLE_TAIL, level: CONSOLE_LEVEL };
  if (!window) return [CONSOLE_COMMAND, parameters];
  const { session, cursor } = consoleWindow(window);
  return [CONSOLE_COMMAND, { ...parameters, since: cursor, 'since-session': session }];
}

const LEVELS = Object.freeze({ error: 'error', warn: 'warn', warning: 'warn', log: 'log' });

/** {error, warn, log} over `entries` (each entry's normalized level). */
function countLevels(entries) {
  const counts = { error: 0, warn: 0, log: 0 };
  for (const entry of entries) {
    const level = typeof entry.level === 'string' ? LEVELS[entry.level.toLowerCase()] : undefined;
    if (level) counts[level] += 1;
  }
  return counts;
}

/** Which window an answer read against `window` covers. */
function scopeOf(answer, window) {
  if (!window) return WINDOW_SCOPE.wholeBuffer;
  if (answer.session !== window.session) return WINDOW_SCOPE.freshSession;
  return answer.reset === true ? WINDOW_SCOPE.cursorReset : WINDOW_SCOPE.sinceStart;
}

/**
 * A `console get` answer cut to the playtest window: the entries, counts over
 * them, the editor's groundTruth, and which window they cover. `unplaced`
 * counts entries left out because they carry no seq to place them after the
 * cursor; `truncated` says the editor returned a full tail, so older entries
 * of the window (and their counts) may be missing; `dropped` is the editor's
 * own gap flag.
 * @param {unknown} answer
 * @param {{session:string, cursor:number, startedAt?:string|null}|null} window
 * @returns {{window:object, entries:object[], counts:object, groundTruth:object|null, unplaced?:number, truncated?:true, dropped?:true}}
 */
function windowedConsole(answer, window) {
  const a = isObj(answer) ? answer : {};
  const all = Array.isArray(a.entries) ? a.entries.filter(isObj) : [];
  const scope = scopeOf(a, window);
  const entries = scope === WINDOW_SCOPE.sinceStart ? all.filter((e) => isCursor(e.seq) && e.seq > window.cursor) : all;
  const unplaced = scope === WINDOW_SCOPE.sinceStart ? all.filter((e) => !isCursor(e.seq)).length : 0;
  const cover = {
    scope,
    startedAt: window ? window.startedAt || null : null,
    session: window ? window.session : null,
    cursor: window ? window.cursor : null,
    ...(scope === WINDOW_SCOPE.freshSession ? { newSession: typeof a.session === 'string' ? a.session : null } : {}),
  };
  return {
    window: cover,
    entries,
    counts: countLevels(entries),
    groundTruth: isObj(a.groundTruth) ? a.groundTruth : null,
    ...(unplaced ? { unplaced } : {}),
    ...(all.length >= CONSOLE_TAIL ? { truncated: true } : {}),
    ...(a.dropped === true ? { dropped: true } : {}),
  };
}

module.exports = {
  CONSOLE_COMMAND,
  CONSOLE_TAIL,
  CONSOLE_LEVEL,
  WINDOW_SCOPE,
  consoleWindow,
  consoleWindowOf,
  consoleCall,
  windowedConsole,
};
