// ============================================================================
// LunaCore - review signals between PCs: rejections, disputes, reads (main + CLI)
// ----------------------------------------------------------------------------
// The memory log (memory-log.local.jsonl, src/memorylog.js) is this PC's own.
// Without this file a title rejected on one PC is still proposed on the other,
// a memory a session reported as wrong is flagged on one PC only, and the read
// counts behind the final score differ per PC. So every PC publishes one
// compact unit in the `memory` scope, beside its heartbeat (src/memoryhealth.js):
//
//   _signals/<machine> = {
//     at:       when it was collected (ms),
//     rejected: [{project, title, at}]   the last MAX_REJECTED inbox rejections, newest first,
//     disputes: [{key, note, at}]        its open "this memory is wrong" reports, newest first,
//     reads:    {"<key>": count}         its top MAX_READS reads of the last 30 days,
//     settled:  {"<key>": at}            its user "still true" of the last 30 days: a dispute
//                                        older than that is settled on every PC,
//   }
//
// and keeps everyone's in memory-signals.local.json = {machines: {<machine>: signals}}.
//
// Rules:
//   - A unit stays under MAX_SIGNAL_BYTES serialized. Over it, the lowest read
//     counts, the oldest settles and the oldest rejections go first, in turn;
//     open disputes last.
//   - Every text (title, note) is secret-scrubbed and cut to one short line,
//     both when this PC publishes it and when a peer's arrives.
//   - A peer's unit is untrusted input: validSignals() rebuilds it field by
//     field. A unit without a valid `at` is dropped whole; a malformed entry
//     inside it is dropped alone.
//   - Publishing is throttled (publishSignals): a changed rejection, dispute
//     or settle goes out after MIN_PUBLISH_MS at the earliest; reads alone
//     after READS_PUBLISH_MS; an unchanged unit is refreshed after REFRESH_MS.
//     Every write is a row the other PCs pull.
//
// Consumers do not take a parameter each: main registers the peers once
// (setPeerSource, done by memorysync.startMemory) and peerSignals() hands them
// to memoryuse.recentUsage (reads), memoryreview.reviewList (disputes) and
// capture (notWantedTitles). No source registered = this PC's log alone, as
// before.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { MACHINE_RE } = require('./missionledgersync');
const { GLOBAL, validProject, splitKey, cleanLine } = require('./memoryrecord');
const { openDisputes, MAX_REJECTED_TITLES, DAY_MS } = require('./memorylog');
const { scrub } = require('./hostscrub');
const { readCounts, RECENT_READ_DAYS } = require('./memoryuse');

const PREFIX = '_signals/';
const MAX_REJECTED = 50;
const MAX_DISPUTES = 20;
const MAX_READS = 100;
const MAX_SETTLED = 50;
/** One unit, serialized (UTF-8). */
const MAX_SIGNAL_BYTES = 6 * 1024;
/** A rejected title as it travels; longer ones are cut before publishing, dropped on arrival. */
const MAX_SIGNAL_TITLE = 120;
const MAX_SIGNAL_NOTE = 200;
const MAX_READ_COUNT = 1e6;
/** The window of `reads` and `settled`: the final score's. */
const SIGNAL_DAYS = RECENT_READ_DAYS;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MIN_PUBLISH_MS = 5 * MINUTE_MS;
const READS_PUBLISH_MS = 6 * HOUR_MS;
const REFRESH_MS = 24 * HOUR_MS;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validAt = (v) => Number.isSafeInteger(v) && v >= 0;
const errText = (err) => (err && (err.code || err.message)) || 'error';
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const machineOf = (k) => (typeof k === 'string' && k.startsWith(PREFIX) && MACHINE_RE.test(k.slice(PREFIX.length)) ? k.slice(PREFIX.length) : null);
/** Newest first (Array.sort is stable: ties keep their order). */
const byAtDesc = (a, b) => b.at - a.at;

/** Text this PC publishes: scrubbed, one line, cut to `max`. */
function clip(raw, max) {
  if (typeof raw !== 'string') return '';
  return cleanLine(scrub(cleanLine(raw)).slice(0, max)).toWellFormed();
}

/** Text from a unit: a string no longer than `max`, scrubbed and cleaned; anything else is ''. */
function textOf(raw, max) {
  if (typeof raw !== 'string' || raw.length > max) return '';
  return cleanLine(scrub(cleanLine(raw))).slice(0, max).toWellFormed();
}

function validRejected(x) {
  if (!isPlainObject(x) || !validProject(x.project) || !validAt(x.at)) return null;
  const title = textOf(x.title, MAX_SIGNAL_TITLE);
  return title ? { project: x.project, title, at: x.at } : null;
}

function validDispute(x) {
  if (!isPlainObject(x) || !splitKey(x.key) || !validAt(x.at)) return null;
  if (x.note !== undefined && typeof x.note !== 'string') return null;
  if (typeof x.note === 'string' && x.note.length > MAX_SIGNAL_NOTE) return null;
  return { key: x.key, note: textOf(x.note || '', MAX_SIGNAL_NOTE), at: x.at };
}

/** A clean list: valid entries only, no repeats (by `idOf`), at most `max`. */
function listOf(raw, valid, idOf, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw.slice(0, max * 2)) {
    const clean = valid(x);
    if (!clean || seen.has(idOf(clean))) continue;
    seen.add(idOf(clean));
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/** {key: n} with memory keys only, sorted by `n` (highest first), at most `max`. */
function mapOf(raw, validValue, max) {
  if (!isPlainObject(raw)) return [];
  return Object.entries(raw)
    .slice(0, max * 2)
    .filter(([k, v]) => splitKey(k) !== null && validValue(v))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

const validCount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_READ_COUNT;

/**
 * A unit under MAX_SIGNAL_BYTES: drops the lowest reads, the oldest settles
 * and the oldest rejections in turn, then the oldest disputes.
 * @param {{at: number, rejected: object[], disputes: object[], reads: [string, number][], settled: [string, number][]}} parts
 *   lists already sorted with the entry to keep longest first
 */
function fit({ at, rejected, disputes, reads, settled }) {
  const lists = { rejected: [...rejected], disputes: [...disputes], reads: [...reads], settled: [...settled] };
  const build = () => ({
    at,
    rejected: lists.rejected,
    disputes: lists.disputes,
    reads: Object.fromEntries(lists.reads),
    settled: Object.fromEntries(lists.settled),
  });
  let doc = build();
  let turn = 0;
  while (bytesOf(doc) > MAX_SIGNAL_BYTES) {
    const pools = [lists.reads, lists.settled, lists.rejected].filter((l) => l.length);
    if (pools.length) pools[turn++ % pools.length].pop();
    else if (lists.disputes.length) lists.disputes.pop();
    else break;
    doc = build();
  }
  return doc;
}

/**
 * Rebuilds a signals unit from untrusted input (a peer's cloud row, the local file).
 * @param {unknown} raw
 * @returns {{at: number, rejected: object[], disputes: object[], reads: object, settled: object}|null}
 */
function validSignals(raw) {
  if (!isPlainObject(raw) || !validAt(raw.at)) return null;
  const rejected = listOf(raw.rejected, validRejected, (r) => `${r.project}\n${r.title}`, MAX_REJECTED).sort(byAtDesc);
  const disputes = listOf(raw.disputes, validDispute, (d) => d.key, MAX_DISPUTES).sort(byAtDesc);
  const reads = mapOf(raw.reads, validCount, MAX_READS);
  const settled = mapOf(raw.settled, validAt, MAX_SETTLED);
  return fit({ at: raw.at, rejected, disputes, reads, settled });
}

/**
 * This PC's signals, from its memory log.
 * @param {object[]} events memorylog readLog(), oldest first
 * @param {number} now ms
 */
function collectSignals(events, now) {
  const since = now - SIGNAL_DAYS * DAY_MS;
  const rejected = [];
  const seen = new Set();
  for (let i = events.length - 1; i >= 0 && rejected.length < MAX_REJECTED; i--) {
    const e = events[i];
    const parts = e.ev === 'rejected' ? splitKey(e.key) : null;
    const title = parts ? clip(e.title, MAX_SIGNAL_TITLE) : '';
    if (!title || !validAt(e.at) || seen.has(`${parts.project}\n${title}`)) continue;
    seen.add(`${parts.project}\n${title}`);
    rejected.push({ project: parts.project, title, at: e.at });
  }
  const disputes = [...openDisputes(events)].map(([key, d]) => ({ key, note: clip(d.note, MAX_SIGNAL_NOTE), at: d.at }));
  const settled = {};
  for (const e of events) {
    if (e.ev === 'verified' && e.by === 'user' && e.at >= since) settled[e.key] = Math.max(settled[e.key] || 0, e.at);
  }
  return validSignals({
    at: now,
    rejected,
    disputes: disputes.sort(byAtDesc).slice(0, MAX_DISPUTES),
    reads: Object.fromEntries(readCounts(events, { since })),
    settled,
  });
}

/** {<machine>: signals}; throws when the file exists but is unreadable. */
function readMachines(file) {
  const doc = readDoc(file);
  const out = {};
  for (const [name, raw] of Object.entries(isPlainObject(doc && doc.machines) ? doc.machines : {})) {
    const clean = MACHINE_RE.test(name) ? validSignals(raw) : null;
    if (clean) out[name] = clean;
  }
  return out;
}

function writeMachines(file, machines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ machines }) + '\n');
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Records this PC's signals when they are due. `collect` is called only then:
 * reading the whole log every sync minute would be waste.
 * @param {string} file memory-signals.local.json
 * @param {string} machine
 * @param {() => object} collect usually () => collectSignals(log.read(), now)
 * @param {number} [now] ms
 * @returns {boolean} whether the file was written
 */
function publishSignals(file, machine, collect, now = Date.now()) {
  if (!MACHINE_RE.test(machine)) return false;
  const machines = readMachines(file);
  const cur = machines[machine];
  const age = cur ? now - cur.at : Infinity;
  // A clock that went back is no reason to stay silent.
  const within = (ms) => age >= 0 && age < ms;
  if (within(MIN_PUBLISH_MS)) return false;
  const next = validSignals(collect());
  if (!next) return false;
  if (cur) {
    const decisions = !sameJson(cur.rejected, next.rejected) || !sameJson(cur.disputes, next.disputes) || !sameJson(cur.settled, next.settled);
    const reads = !sameJson(cur.reads, next.reads);
    if (!decisions && (!reads || within(READS_PUBLISH_MS)) && within(REFRESH_MS)) return false;
  }
  writeMachines(file, { ...machines, [machine]: next });
  return true;
}

/** The signals as a configsync.js provider (scope `memory`). */
function createSignalsProvider(file) {
  return {
    name: 'memory-signals',
    owns: (k) => machineOf(k) !== null,
    valid: (k, v) => (machineOf(k) ? validSignals(v) : null),
    read() {
      const machines = readMachines(file);
      // base 0: after a lost sync state the cloud's copies win until the next publish.
      return { units: Object.entries(machines).map(([name, s]) => [PREFIX + name, s]), base: 0, fresh: !fs.existsSync(file) };
    },
    write(units) {
      writeMachines(file, Object.fromEntries(units.map(([k, v]) => [machineOf(k), v])));
    },
  };
}

/**
 * Every other PC's signals in the file.
 * @returns {{machine: string, at: number, rejected: object[], disputes: object[], reads: object, settled: object}[]}
 *   sorted by machine; throws when the file exists but is unreadable
 */
function readPeers(file, self) {
  return Object.entries(readMachines(file))
    .filter(([name]) => name !== self)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([machine, s]) => ({ machine, ...s }));
}

let peerSource = null;

/**
 * Registers where peerSignals() reads from (main: memorysync.startMemory).
 * @param {(() => object[])|null} fn usually () => readPeers(file, machine); null unregisters
 */
function setPeerSource(fn) {
  peerSource = typeof fn === 'function' ? fn : null;
}

/** The other PCs' signals, or [] without a source or when it fails (logged): a peer never breaks this PC. */
function peerSignals() {
  if (!peerSource) return [];
  try {
    const list = peerSource();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('[memory] peer signals unavailable:', errText(err));
    return [];
  }
}

/**
 * The titles capture tells the extractor not to propose again: the ones
 * rejected for this project (or globally) on this PC and on the others,
 * newest first, without repeats. Takes the place of memorylog.rejectedTitles.
 * @param {object[]} events this PC's log
 * @param {string} project
 * @param {object[]} [peers] peerSignals()
 * @returns {string[]}
 */
function notWantedTitles(events, project, peers = peerSignals(), max = MAX_REJECTED_TITLES) {
  const wanted = (p) => p === project || p === GLOBAL;
  const all = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const parts = e.ev === 'rejected' && e.title ? splitKey(e.key) : null;
    if (parts && wanted(parts.project)) all.push({ title: e.title, at: Number(e.at) || 0, order: all.length });
  }
  for (const p of peers) {
    for (const r of p.rejected || []) if (wanted(r.project)) all.push({ title: r.title, at: r.at, order: all.length });
  }
  // Newest first; on a tie this PC's own (listed first) wins.
  all.sort((a, b) => b.at - a.at || a.order - b.order);
  const titles = [];
  for (const { title } of all) {
    if (titles.length >= max) break;
    if (!titles.includes(title)) titles.push(title);
  }
  return titles;
}

/** Per memory, the newest user "still true" on this PC (whole log) or any other (their window). */
function settledAt(events, peers) {
  const at = new Map();
  const bump = (key, t) => at.set(key, Math.max(at.get(key) || 0, t));
  for (const e of events) if (e.ev === 'verified' && e.by === 'user') bump(e.key, e.at);
  for (const p of peers) for (const [key, t] of Object.entries(p.settled || {})) bump(key, t);
  return at;
}

/**
 * The open "wrong" reports of every PC. This PC's come from its log
 * (memorylog.openDisputes); another PC's from its signals, marked with its
 * machine. A report is settled by a user's "still true" newer than it on any
 * PC; a retired memory has no file left to flag. Per memory the newest report wins.
 * @param {object[]} events this PC's log
 * @param {object[]} [peers] peerSignals()
 * @returns {Map<string, {at: number, note: string, by: string, run?: string, machine?: string}>}
 */
function allDisputes(events, peers = peerSignals()) {
  const settled = settledAt(events, peers);
  const open = new Map();
  const consider = (key, d) => {
    if ((settled.get(key) ?? -1) >= d.at) return;
    const cur = open.get(key);
    if (!cur || d.at > cur.at) open.set(key, d);
  };
  for (const [key, d] of openDisputes(events)) consider(key, d);
  for (const p of peers) {
    for (const d of p.disputes || []) consider(d.key, { at: d.at, note: d.note, by: 'peer', machine: p.machine });
  }
  return open;
}

/**
 * This PC's reads plus the other PCs' (memoryuse.recentUsage). A peer whose
 * signals are older than the window counts no more: its reads would be stale.
 * @param {Map<string, number>} local
 * @param {object[]} peers peerSignals()
 * @param {{now: number, days?: number}} opts
 * @returns {Map<string, number>} a new map
 */
function mergeReads(local, peers, { now, days = SIGNAL_DAYS }) {
  const out = new Map(local);
  const since = now - days * DAY_MS;
  for (const p of peers) {
    // A peer clock far ahead would keep its reads counting forever.
    if (!(p.at >= since && p.at <= now + DAY_MS)) continue;
    for (const [key, n] of Object.entries(p.reads || {})) out.set(key, (out.get(key) || 0) + n);
  }
  return out;
}

module.exports = {
  validSignals,
  collectSignals,
  publishSignals,
  createSignalsProvider,
  readPeers,
  setPeerSource,
  peerSignals,
  notWantedTitles,
  allDisputes,
  mergeReads,
  PREFIX,
  MAX_SIGNAL_BYTES,
  MAX_REJECTED,
  MAX_DISPUTES,
  MAX_READS,
  MAX_SIGNAL_TITLE,
  MAX_SIGNAL_NOTE,
  MIN_PUBLISH_MS,
  READS_PUBLISH_MS,
  REFRESH_MS,
};
