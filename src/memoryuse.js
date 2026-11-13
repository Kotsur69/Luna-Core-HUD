// ============================================================================
// LunaCore - how memories are used, read from the memory log (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 5 ("Card reads are not
// counted") and section 9. Pure functions over src/memorylog.js events:
//
//   readCounts    per memory, how often it was returned by memory_search or
//                 opened with memory_get: the card orders its one-line
//                 entries by it (src/memorycard.js).
//   lastOpened    per memory, when memory_get last opened it: the review list
//                 flags a confirmed memory nobody opened for UNOPENED_DAYS
//                 (src/memoryreview.js).
//   cardSessions  sessions started with the project card against those
//                 started without it, and the memory tool calls of each: the
//                 with/without evidence of section 9 (`luna memory stats`).
//
// The log is this PC's only and trims reads first, so every number here is a
// lower bound for this PC, never a fact about the other one.
// ============================================================================

'use strict';

/** The card ranks a memory by the reads of this many recent days. */
const RECENT_READ_DAYS = 30;
/** The memory tools a session can call, as cardSessions() counts them. */
const TOOL_CALLS = Object.freeze(['search', 'get', 'verify', 'propose']);

/**
 * Which tool call a log event stands for, or null. A `verified` or
 * `disputed` written by the user is not a tool call; a `proposed` written by
 * capture is not either. Only calls that succeeded are in the log, and a
 * repeated report of the same memory is logged once (memoryreview.js).
 * @param {object} e
 * @returns {'search'|'get'|'verify'|'propose'|null}
 */
function callOf(e) {
  if (e.ev === 'search' || e.ev === 'get') return e.ev;
  if ((e.ev === 'verified' || e.ev === 'disputed') && e.by === 'tool') return 'verify';
  if (e.ev === 'proposed' && e.by === 'session') return 'propose';
  return null;
}

/**
 * How often each memory was read since `since`: found by a search plus
 * opened with memory_get.
 * @param {object[]} events memorylog readLog()
 * @param {{since?: number}} [opts]
 * @returns {Map<string, number>} key -> reads
 */
function readCounts(events, { since = 0 } = {}) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const e of events) {
    if (e.at < since) continue;
    if (e.ev === 'search') for (const key of e.hits) bump(key);
    else if (e.ev === 'get') bump(e.key);
  }
  return counts;
}

/**
 * When each memory was last opened with memory_get.
 * @param {object[]} events
 * @returns {Map<string, number>} key -> ms
 */
function lastOpened(events) {
  const last = new Map();
  for (const e of events) {
    if (e.ev === 'get') last.set(e.key, Math.max(last.get(e.key) || 0, e.at));
  }
  return last;
}

/**
 * The time of the oldest read (search or get) still in the log, or null.
 * The review list only says "never opened in N days" when the log reaches
 * back that far: a new or freshly trimmed log knows nothing older.
 * @param {object[]} events
 * @returns {number|null}
 */
function oldestRead(events) {
  let oldest = null;
  for (const e of events) {
    if ((e.ev === 'search' || e.ev === 'get') && (oldest === null || e.at < oldest)) oldest = e.at;
  }
  return oldest;
}

const emptyCalls = () => ({ search: 0, get: 0, verify: 0, propose: 0 });

/** Totals of one side (with or without the card). */
function sideOf(list) {
  const total = { sessions: list.length, calls: 0, ...emptyCalls() };
  for (const s of list) {
    for (const kind of TOOL_CALLS) total[kind] += s.calls[kind];
  }
  total.calls = TOOL_CALLS.reduce((sum, kind) => sum + total[kind], 0);
  return { ...total, perSession: list.length ? total.calls / list.length : null };
}

/**
 * Sessions started with the project card against those started without it.
 * A session is a `card` line of a tab and the tagged tool events of that tab
 * up to its next `card` line. Tool events of a tab with no `card` line before
 * them (an older log, a trimmed start) belong to no session. A start logged
 * with `tools: false` (no memory tools attached) is left out of both sides:
 * it could not have called one, and would only pull its side's average down.
 * @param {object[]} events oldest first, as readLog() returns them
 * @param {{since?: number, project?: string|null}} [opts] since = ms, by the start;
 *   project = only starts in this project
 * @returns {{withCard: object, withoutCard: object}} each
 *   {sessions, calls, search, get, verify, propose, perSession: number|null}
 */
function cardSessions(events, { since = 0, project = null } = {}) {
  const open = new Map();
  const counted = [];
  for (const e of events) {
    if (e.ev === 'card') {
      const start = { loaded: e.loaded, calls: emptyCalls() };
      open.set(e.session, start);
      if (e.tools !== false && e.at >= since && (!project || e.project === project)) counted.push(start);
      continue;
    }
    const kind = callOf(e);
    const start = kind && e.session ? open.get(e.session) : null;
    if (start) start.calls[kind] += 1;
  }
  return {
    withCard: sideOf(counted.filter((s) => s.loaded)),
    withoutCard: sideOf(counted.filter((s) => !s.loaded)),
  };
}

/** Calls per session with one decimal, "n/a" for no session. */
const perSessionText = (v) => (v === null ? 'n/a' : (Math.round(v * 10) / 10).toFixed(1));

/**
 * The with/without lines `luna memory stats` prints.
 * @param {ReturnType<typeof cardSessions>} stats
 * @returns {string[]}
 */
function cardSessionLines({ withCard, withoutCard }) {
  const lineOf = (label, side) =>
    `${label}: ${side.sessions} session(s), ${side.calls} memory tool call(s), ${perSessionText(side.perSession)} per session` +
    ` (search ${side.search}, get ${side.get}, verify ${side.verify}, propose ${side.propose})`;
  return [lineOf('with the card', withCard), lineOf('without the card', withoutCard)];
}

module.exports = { readCounts, lastOpened, oldestRead, cardSessions, cardSessionLines, callOf, RECENT_READ_DAYS, TOOL_CALLS };
