// ============================================================================
// LunaCore - keeping memories true: staleness, anchors, the review list (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 5 (section 8). The inbox
// (src/memoryinbox.js) holds what is not confirmed yet. This file looks after
// what IS confirmed, because a confidently wrong memory is worse than none:
//
//   stale     a `gotcha` or `how-to` nobody has verified for STALE_DAYS. It is
//             still returned, ranked lower and labelled "not verified since".
//   anchor    the memory names a file of its repository (`src/x.js`) and that
//             file is gone. Checked only on a PC that has the repository, and
//             only for a path whose top folder exists there.
//   changed   a file the memory names has a commit after the day it was last
//             checked (src/memorychanges.js asks git, cached; this file only
//             reads the answer). Compared by UTC day: a commit made later on
//             the day of a "still true" is not flagged.
//   disputed  a session reported through `memory_verify` that the memory was
//             wrong (src/memorylog.js keeps the report).
//   checked   "Check if still true" (src/memorycheck.js) found it fixed, partly
//             true or fixable, and nobody has acted on that yet.
//   decayed   a `digest` older than DIGEST_DAYS drops out of search. The file
//             stays: archived, not deleted.
//   unopened  low priority: a confirmed memory last checked more than
//             UNOPENED_DAYS ago that no memory_get on this PC opened in that
//             time. Only said when this PC's log reaches back that far.
//
// The review list is every confirmed memory with at least one flag. Per entry
// the user says "still true" (last_verified -> today, the flags clear) or
// retires it (the file is deleted, a tombstone for the other PCs).
//
// A session may report, never decide: `memory_verify` can refresh the
// verification date of a confirmed memory and can flag one as wrong. It cannot
// confirm, edit or delete anything.
//
// No Electron here: scripts/luna.js uses the same functions with the app closed.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { splitKey, scoreOf, DATE_RE } = require('./memoryrecord');
const { scan, writeRecord, removeRecord, fileFor } = require('./memorystore');
const { openDisputes, openChecks, acceptedMissing, DAY_MS } = require('./memorylog');
const { lastOpened, oldestRead } = require('./memoryuse');
const { FULL_AREA_IDS } = require('./memorycard');

/** A gotcha or how-to unverified for this long is flagged (tools and commands change). */
const STALE_DAYS = 180;
const STALE_TYPES = ['gotcha', 'how-to'];
/** A digest older than this is no longer searched. */
const DIGEST_DAYS = 60;
/** A session's "it held" moves last_verified at most this often: every bump is a sync push. */
const REVERIFY_DAYS = 7;
const MAX_ANCHORS = 20;
const MAX_ITEMS = 100;
/** A confirmed memory checked longer ago than this and never opened since is flagged, at low priority. */
const UNOPENED_DAYS = 60;
/** Worst first. A flag listed in LOW_FLAGS alone does not count toward the hub's number. */
const FLAG_ORDER = ['disputed', 'checked', 'anchor', 'changed', 'stale', 'unopened'];
const LOW_FLAGS = ['unopened'];

const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
/** The day a memory was last known to be true. */
const checkedOn = (record) => record.last_verified || record.created;

/** A confirmed gotcha or how-to that nobody has verified for STALE_DAYS. */
function isStale(record, today) {
  return record.confidence === 'confirmed' && STALE_TYPES.includes(record.type) && daysBetween(checkedOn(record), today) > STALE_DAYS;
}

/** A digest that is too old to be searched. */
function isDecayed(record, today) {
  return record.type === 'digest' && daysBetween(record.created, today) > DIGEST_DAYS;
}

const CODE_SPAN_RE = /`([^`\n]{3,200})`/g;
/** A relative path with at least one folder and a file extension: `src/main.js`. */
const ANCHOR_RE = /^[\w@.-]+(?:\/[\w@.()[\]-]+)+\.[A-Za-z0-9]{1,8}$/;
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|ai|dev|app|pl)$/i;

/**
 * The repository files a memory names in backticks.
 * Only what is certainly a path of the repository counts: a bare file name
 * (`main.js`) could be anywhere, a `*.local.*` file is this PC's own, and
 * `node_modules` is not the repository's.
 * @param {string} body
 * @returns {string[]} repo-relative paths with forward slashes
 */
function anchorsOf(body) {
  const anchors = new Set();
  for (const [, span] of String(body || '').matchAll(CODE_SPAN_RE)) {
    const token = span
      .trim()
      .replace(/^\.\//, '')
      .replace(/:\d+(-\d+)?$/, '');
    if (!ANCHOR_RE.test(token) || token.includes('.local.')) continue;
    const segments = token.split('/');
    if (segments.includes('.') || segments.includes('..') || segments[0] === 'node_modules' || DOMAIN_RE.test(segments[0])) continue;
    anchors.add(token);
    if (anchors.size >= MAX_ANCHORS) break;
  }
  return [...anchors];
}

/**
 * The named files that are not in the repository.
 * @param {{body: string}} record
 * @param {string|null|undefined} root the repository's folder on this PC; none = not checked
 * @returns {string[]}
 */
function missingAnchors(record, root) {
  if (!root) return [];
  const base = path.resolve(root);
  return anchorsOf(record.body).filter((anchor) => {
    const segments = anchor.split('/');
    const file = path.resolve(base, ...segments);
    // anchorsOf() lets no `..` through; this is the second lock on the same door.
    if (!file.startsWith(base + path.sep)) return false;
    // A path whose top folder is not in this repository names something else:
    // another repository, a path inside node_modules, a folder of the user's.
    return fs.existsSync(path.join(base, segments[0])) && !fs.existsSync(file);
  });
}

/**
 * The named files that have a commit after the day the memory was last
 * checked, by UTC day. Pure: the commits come from src/memorychanges.js.
 * @param {{body: string, created: string, last_verified?: string}} record
 * @param {Map<string, string>|null|undefined} changes anchor path -> ISO time of its newest commit
 * @returns {{files: string[], last: string}|null} last = YYYY-MM-DD of the newest of those commits
 */
function changedSince(record, changes) {
  if (!(changes instanceof Map) || !changes.size) return null;
  const since = checkedOn(record);
  const files = [];
  let last = '';
  for (const anchor of anchorsOf(record.body)) {
    const at = changes.get(anchor);
    const day = typeof at === 'string' ? at.slice(0, 10) : '';
    if (!DATE_RE.test(day) || day <= since) continue;
    files.push(anchor);
    if (day > last) last = day;
  }
  return files.length ? { files, last } : null;
}

/** The keys a confirmed memory of the same project has replaced. */
function supersededKeys(records) {
  const gone = new Set();
  for (const [, r] of records) {
    if (r.confidence === 'confirmed') for (const old of r.supersedes) gone.add(`${r.project}/${old}`);
  }
  return gone;
}

/**
 * A predicate for "no memory_get opened it in UNOPENED_DAYS", or null when the
 * log cannot tell: it holds no read that old (a new PC, a trimmed log).
 * The day it was last checked counts too, so "still true" clears the flag.
 * A memory the project card prints in full is read from the card, never
 * opened, so it is not flagged.
 */
function unopenedCheck(events, today) {
  const cutoff = Date.parse(today) - UNOPENED_DAYS * DAY_MS;
  const oldest = oldestRead(events);
  if (!Number.isFinite(cutoff) || oldest === null || oldest > cutoff) return null;
  const opened = lastOpened(events);
  return (key, record) =>
    !FULL_AREA_IDS.includes(record.area) && daysBetween(checkedOn(record), today) > UNOPENED_DAYS && (opened.get(key) || 0) < cutoff;
}

/**
 * The confirmed memories that need a look.
 * @param {{records: [string, object][], today: string, events?: object[], roots?: object, changes?: object}} ctx
 *   records = memorystore.scan().records; events = the memory log;
 *   roots = {<project>: its folder on this PC}, for the anchor check;
 *   changes = {<project>: Map<anchorPath, newestCommitISO>} (src/memorychanges.js);
 *   a project without an entry gets no 'changed' flags
 * @returns {{items: object[], total: number, urgent: number}} worst first: disputed, checked,
 *   anchors, changed, stale, then unopened; urgent = how many carry more than a low-priority flag
 */
function reviewList({ records, today, events = [], roots = {}, changes = {} }) {
  const disputes = openDisputes(events);
  const checks = openChecks(events);
  const accepted = acceptedMissing(events);
  const gone = supersededKeys(records);
  const unopened = unopenedCheck(events, today);
  const items = [];
  for (const [key, record] of records) {
    // An archived memory (src/memorydecay.js) is out of the way until restored.
    if (record.confidence !== 'confirmed' || gone.has(key) || record.archived) continue;
    const flags = [];
    const dispute = disputes.get(key);
    // run = the God Mode run that reported it obsolete (src/memoryrunstale.js), when one did.
    if (dispute) flags.push({ kind: 'disputed', at: dispute.at, note: dispute.note, ...(dispute.run ? { run: dispute.run } : {}) });
    const check = checks.get(key);
    if (check) flags.push({ kind: 'checked', at: check.at, verdict: check.verdict, note: check.note });
    const seen = accepted.get(key) || new Set();
    const missing = missingAnchors(record, roots[record.project]).filter((p) => !seen.has(p));
    if (missing.length) flags.push({ kind: 'anchor', missing });
    const commits = changes && Object.hasOwn(changes, record.project) ? changes[record.project] : null;
    const changed = changedSince(record, commits);
    // A file that is gone is the anchor flag's: its deletion is not a second reason.
    const files = changed ? changed.files.filter((f) => !missing.includes(f)) : [];
    if (files.length) flags.push({ kind: 'changed', files, last: changed.last });
    if (isStale(record, today)) flags.push({ kind: 'stale', since: checkedOn(record) });
    if (unopened && unopened(key, record)) flags.push({ kind: 'unopened', days: UNOPENED_DAYS });
    if (!flags.length) continue;
    items.push({
      key,
      project: record.project,
      id: record.id,
      type: record.type,
      title: record.title,
      body: record.body,
      created: record.created,
      last_verified: record.last_verified || null,
      flags,
      ...scoreOf(record),
    });
  }
  const rank = (item) => Math.min(...item.flags.map((f) => FLAG_ORDER.indexOf(f.kind)));
  items.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  const urgent = items.filter((item) => item.flags.some((f) => !LOW_FLAGS.includes(f.kind))).length;
  return { items: items.slice(0, MAX_ITEMS), total: items.length, urgent };
}

/** The confirmed memory with this key, or a reason. */
function findConfirmed(dir, key) {
  if (!splitKey(key)) return { reason: 'bad-key' };
  const found = scan(dir).records.find(([k]) => k === key);
  if (!found) return { reason: 'not-found' };
  return found[1].confidence === 'confirmed' ? { record: found[1] } : { reason: 'not-confirmed' };
}

/**
 * The user says a confirmed memory is still true: its flags clear. The memory
 * check (src/memorycheck.js) says the same with by 'check': the date moves,
 * but a dispute or a missing file is still the user's to accept.
 * @param {string} dir the mirror folder
 * @param {string} key
 * @param {string} today YYYY-MM-DD
 * @param {{log?: {add: Function}, roots?: object, by?: 'user'|'check', note?: string, evidence?: string[]}} [opts]
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function verify(dir, key, today, { log = null, roots = {}, by = 'user', note = '', evidence = [] } = {}) {
  const found = findConfirmed(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  const { record } = found;
  writeRecord(dir, { ...record, last_verified: today });
  if (!log) return { ok: true, key };
  // The files missing today were seen and accepted by the user: they are not flagged again.
  if (by === 'user') log.add({ ev: 'verified', key, by: 'user', missing: missingAnchors(record, roots[record.project]) });
  else log.add({ ev: 'verified', key, by: 'check', note, evidence });
  return { ok: true, key };
}

/**
 * The user retires a confirmed memory: its file is deleted on every PC.
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function retire(dir, key, { log = null } = {}) {
  const found = findConfirmed(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  removeRecord(dir, key);
  if (log) log.add({ ev: 'retired', key, type: found.record.type, title: found.record.title });
  return { ok: true, key };
}

/**
 * A session reports how a memory it relied on turned out (`memory_verify`).
 * @param {string} dir
 * @param {{key: string, outcome: 'holds'|'wrong', note?: string, today: string, log?: {add: Function}}} report
 * @returns {{ok: true, key: string, status: 'flagged'|'waiting'|'fresh'|'verified', changed: boolean}|{ok: false, reason: string}}
 *   flagged = on the user's review list, the memory is unchanged;
 *   waiting = not confirmed yet, only the user's approval confirms it;
 *   fresh = verified recently, nothing written; verified = last_verified moved to today
 */
function toolVerdict(dir, { key, outcome, note = '', today, log = null }) {
  if (!splitKey(key)) return { ok: false, reason: 'bad-key' };
  const found = scan(dir).records.find(([k]) => k === key);
  if (!found) return { ok: false, reason: 'not-found' };
  const record = found[1];
  if (outcome === 'wrong') {
    // A report lives only in the log: without one, or when the write fails,
    // the session must not be told that the user will see it.
    if (!log) return { ok: false, reason: 'log' };
    // One open report per memory: a session cannot bury the list under repeats.
    if (!openDisputes(log.read()).has(key) && !log.add({ ev: 'disputed', key, by: 'tool', note })) return { ok: false, reason: 'log' };
    return { ok: true, key, status: 'flagged', changed: false };
  }
  if (outcome !== 'holds') return { ok: false, reason: 'bad-outcome' };
  if (log) log.add({ ev: 'verified', key, by: 'tool' });
  if (record.confidence !== 'confirmed') return { ok: true, key, status: 'waiting', changed: false };
  if (record.last_verified && daysBetween(record.last_verified, today) < REVERIFY_DAYS) return { ok: true, key, status: 'fresh', changed: false };
  // Retired since the scan above: writing now would bring the memory back on every PC.
  if (!fs.existsSync(fileFor(dir, key))) return { ok: false, reason: 'not-found' };
  writeRecord(dir, { ...record, last_verified: today });
  return { ok: true, key, status: 'verified', changed: true };
}

module.exports = {
  findConfirmed,
  isStale,
  isDecayed,
  checkedOn,
  anchorsOf,
  missingAnchors,
  changedSince,
  reviewList,
  supersededKeys,
  verify,
  retire,
  toolVerdict,
  STALE_DAYS,
  STALE_TYPES,
  DIGEST_DAYS,
  REVERIFY_DAYS,
  UNOPENED_DAYS,
  MAX_ITEMS,
  FLAG_ORDER,
  LOW_FLAGS,
};
