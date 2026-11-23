// ============================================================================
// LunaCore - how memories are used, read from the memory log (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 5 ("Card reads are not
// counted") and section 9. Pure functions over src/memorylog.js events:
//
//   readCounts    per memory, how often it was returned by memory_search or
//                 opened with memory_get: the card orders its one-line
//                 entries by it (src/memorycard.js).
//   recentUsage   the same reads over the last RECENT_READ_DAYS: the usage
//                 part of a memory's final score (memoryrecord.finalScore).
//   lastOpened    per memory, when memory_get last opened it: the review list
//                 flags a confirmed memory nobody opened for UNOPENED_DAYS
//                 (src/memoryreview.js).
//   cardSessions  sessions started with the project card against those
//                 started without it, and the memory tool calls of each: the
//                 with/without evidence of section 9 (`luna memory stats`).
//   failingBriefs per memory, the God Mode packages its brief injection went
//                 into lately and how they ended (`brief-outcome` lines,
//                 src/orchestraBriefMemory.js): the review list flags a
//                 confirmed memory that keeps going into failed or stalled
//                 packages and never into a clean one (src/memoryreview.js).
//
// The log is this PC's only and trims reads first, so every number here is a
// lower bound for this PC, never a fact about the other one. recentUsage alone
// adds the other PCs' reads (their `_signals/<machine>` units, src/memorysignals.js),
// so the final score and auto-accept see the reads of every PC.
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The usage the final score of every memory needs (memoryrecord.finalScore):
 * the reads of the last RECENT_READ_DAYS, this PC's plus the other PCs'
 * (memorysignals.mergeReads), and today's date for the `last_used` rule.
 * @param {object[]} events memorylog readLog()
 * @param {number} now ms
 * @param {object[]} [peers] the other PCs' signals; default memorysignals.peerSignals()
 *   (none registered = this PC's reads alone)
 * @returns {{reads: Map<string, number>, today: string}}
 */
function recentUsage(events, now, peers) {
  // Lazy: memoryrecord requires this file, and memorysignals requires memoryrecord.
  const { peerSignals, mergeReads } = require('./memorysignals');
  const others = Array.isArray(peers) ? peers : peerSignals();
  const own = readCounts(events, { since: now - RECENT_READ_DAYS * DAY_MS });
  const reads = others.length ? mergeReads(own, others, { now, days: RECENT_READ_DAYS }) : own;
  return { reads, today: new Date(now).toISOString().slice(0, 10) };
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

/** The window brief outcomes are counted in. */
const FAILING_BRIEF_DAYS = 30;
/** Failed or stalled packages (and no clean one) that put a memory on the review list. */
const MIN_FAILED_BRIEFS = 3;

const emptyOutcomes = () => ({ clean: 0, retried: 0, stalled: 0, failed: 0 });

/**
 * The confirmed-memory candidates for the review list's 'failing' flag: memories
 * whose brief injection went into at least MIN_FAILED_BRIEFS failed or stalled
 * God Mode packages, and into no clean one, in the last FAILING_BRIEF_DAYS.
 * The latest line of a package counts (a Retry after the run settled logs it
 * again). What came before the memory's last "still true" (by the user or by
 * "Check if still true") does not count: that answered the question.
 * @param {object[]} events memorylog readLog(), oldest first
 * @param {{now: number}} opts ms
 * @returns {Map<string, {clean: number, retried: number, stalled: number, failed: number, days: number}>}
 */
function failingBriefs(events, { now }) {
  const since = now - FAILING_BRIEF_DAYS * DAY_MS;
  const settled = new Map();
  const latest = new Map();
  for (const e of events) {
    if (e.ev === 'verified' && (e.by === 'user' || e.by === 'check')) settled.set(e.key, Math.max(settled.get(e.key) || 0, e.at));
    else if (e.ev === 'brief-outcome' && e.at >= since && e.at <= now) latest.set(`${e.project}\n${e.runId}\n${e.pkgId}`, e);
  }
  const counts = new Map();
  for (const e of latest.values()) {
    for (const key of e.keys) {
      if (e.at <= (settled.get(key) || 0)) continue;
      const c = counts.get(key) || emptyOutcomes();
      counts.set(key, { ...c, [e.outcome]: c[e.outcome] + 1 });
    }
  }
  const failing = new Map();
  for (const [key, c] of counts) {
    if (c.failed + c.stalled >= MIN_FAILED_BRIEFS && c.clean === 0) failing.set(key, { ...c, days: FAILING_BRIEF_DAYS });
  }
  return failing;
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

// ---- `luna memory audit` -------------------------------------------------------

/** An approval rate under this share is flagged: the extractor is proposing more noise than keepers. */
const AUDIT_RED_RATE = 1 / 3;
/** The usefulness distribution's buckets, lowest first: [label, lowest score in it]. */
const AUDIT_BUCKETS = Object.freeze([
  ['<50', 0],
  ['50-69', 50],
  ['70-89', 70],
  ['90+', 90],
]);
const HOUR_MS = 60 * 60 * 1000;

const auditPct = (approved, rejected) => (approved + rejected ? `${Math.round((approved / (approved + rejected)) * 100)}%` : 'n/a');
/** A decision rate line; `!` in front when the rate is under a third. */
function rateLine(label, { approved, rejected }) {
  const decided = approved + rejected;
  const red = decided > 0 && approved / decided < AUDIT_RED_RATE;
  return `${red ? '! ' : '  '}${label}: ${auditPct(approved, rejected)} (${approved} approved, ${rejected} rejected)${red ? '  <-- under 33%' : ''}`;
}

/** "3 h" / "2 d" / "just now" for a sync lag in ms. */
function lagText(ms) {
  if (ms < HOUR_MS) return `${Math.max(0, Math.round(ms / 60000))} min`;
  return ms < 48 * HOUR_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / (24 * HOUR_MS))} d`;
}

/**
 * The memory quality-gate report `luna memory audit` prints: approval rate,
 * usefulness distribution, graveyard, tool use, brief outcomes and sync lag.
 * Pure: it reads only the events (this PC's log) and the optional health list.
 * @param {object[]} events memorylog readLog()
 * @param {{days?: number, now?: number, machines?: {machine: string, at: number, self?: boolean, silent?: boolean}[]}} [opts]
 *   machines = the sync health of every PC (memorysync.localStatus().machines); lag = now - at
 * @returns {string} the report, one line per row
 */
function auditReport(events, { days = 30, now = Date.now(), machines = [] } = {}) {
  const since = now - days * DAY_MS;
  const inWindow = events.filter((e) => e.at >= since && e.at <= now);
  const out = [`Memory audit: last ${days} day(s) (this PC's log)`];
  if (!inWindow.length) out.push('  No memory-log events in this window.');

  const total = { approved: 0, rejected: 0 };
  const byType = {};
  const buckets = AUDIT_BUCKETS.map(([label]) => ({ label, n: 0 }));
  let unscored = 0;
  const graveyard = {};
  const calls = { cards: 0, search: 0, get: 0, propose: 0, recall: 0 };
  const outcomes = emptyOutcomes();
  for (const e of inWindow) {
    if (e.ev === 'approved' || e.ev === 'rejected') {
      byType[e.type] = byType[e.type] || { approved: 0, rejected: 0 };
      byType[e.type][e.ev] += 1;
      total[e.ev] += 1;
    } else if (e.ev === 'proposed') {
      if (e.usefulness === undefined) unscored += 1;
      else buckets[AUDIT_BUCKETS.findLastIndex(([, min]) => e.usefulness >= min)].n += 1;
      if (e.by === 'session') calls.propose += 1;
    } else if (e.ev === 'dropped') graveyard[e.reason] = (graveyard[e.reason] || 0) + 1;
    else if (e.ev === 'card') calls.cards += 1;
    else if (e.ev === 'search' || e.ev === 'get' || e.ev === 'recall') calls[e.ev] += 1;
    else if (e.ev === 'brief-outcome') outcomes[e.outcome] += 1;
  }

  out.push('Approval rate (approved / decided):', rateLine('overall', total));
  for (const [type, c] of Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))) out.push(rateLine(type, c));

  out.push('Usefulness of proposed candidates:');
  for (const b of buckets) out.push(`  ${b.label.padStart(5)}: ${b.n}`);
  if (unscored) out.push(`  no score: ${unscored}`);

  const dead = Object.entries(graveyard).sort(([, a], [, b]) => b - a);
  out.push(dead.length ? `Graveyard (dropped before the inbox): ${dead.map(([r, n]) => `${r} ${n}`).join(', ')}` : 'Graveyard: empty');

  out.push(`Tool use: ${calls.cards} card start(s), memory_search ${calls.search}, memory_get ${calls.get}, memory_propose ${calls.propose}, auto-recall ${calls.recall}`);

  const briefs = outcomes.clean + outcomes.retried + outcomes.stalled + outcomes.failed;
  out.push(`Brief outcomes: ${briefs} package(s): clean ${outcomes.clean}, retried ${outcomes.retried}, stalled ${outcomes.stalled}, failed ${outcomes.failed}`);

  if (machines.length) {
    out.push('Sync lag per PC:');
    for (const m of machines) out.push(`  ${m.machine}${m.self ? ' (this PC)' : ''}: last sync ${lagText(Math.max(0, now - m.at))} ago${m.silent ? '  <-- silent' : ''}`);
  } else out.push('Sync lag: no health data.');
  return out.join('\n');
}

module.exports = {
  auditReport,
  AUDIT_RED_RATE,
  readCounts,
  recentUsage,
  lastOpened,
  oldestRead,
  cardSessions,
  cardSessionLines,
  callOf,
  failingBriefs,
  RECENT_READ_DAYS,
  TOOL_CALLS,
  FAILING_BRIEF_DAYS,
  MIN_FAILED_BRIEFS,
};
