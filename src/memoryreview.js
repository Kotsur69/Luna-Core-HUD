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
//   disputed  a session reported through `memory_verify` that the memory was
//             wrong (src/memorylog.js keeps the report).
//   decayed   a `digest` older than DIGEST_DAYS drops out of search. The file
//             stays: archived, not deleted.
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
const { splitKey } = require('./memoryrecord');
const { scan, writeRecord, removeRecord, fileFor } = require('./memorystore');
const { openDisputes, acceptedMissing, DAY_MS } = require('./memorylog');

/** A gotcha or how-to unverified for this long is flagged (tools and commands change). */
const STALE_DAYS = 180;
const STALE_TYPES = ['gotcha', 'how-to'];
/** A digest older than this is no longer searched. */
const DIGEST_DAYS = 60;
/** A session's "it held" moves last_verified at most this often: every bump is a sync push. */
const REVERIFY_DAYS = 7;
const MAX_ANCHORS = 20;
const MAX_ITEMS = 100;
const FLAG_ORDER = ['disputed', 'anchor', 'stale'];

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

/** The keys a confirmed memory of the same project has replaced. */
function supersededKeys(records) {
  const gone = new Set();
  for (const [, r] of records) {
    if (r.confidence === 'confirmed') for (const old of r.supersedes) gone.add(`${r.project}/${old}`);
  }
  return gone;
}

/**
 * The confirmed memories that need a look.
 * @param {{records: [string, object][], today: string, events?: object[], roots?: object}} ctx
 *   records = memorystore.scan().records; events = the memory log;
 *   roots = {<project>: its folder on this PC}, for the anchor check
 * @returns {{items: object[], total: number}} worst first: disputed, then anchors, then stale
 */
function reviewList({ records, today, events = [], roots = {} }) {
  const disputes = openDisputes(events);
  const accepted = acceptedMissing(events);
  const gone = supersededKeys(records);
  const items = [];
  for (const [key, record] of records) {
    if (record.confidence !== 'confirmed' || gone.has(key)) continue;
    const flags = [];
    const dispute = disputes.get(key);
    if (dispute) flags.push({ kind: 'disputed', at: dispute.at, note: dispute.note });
    const seen = accepted.get(key) || new Set();
    const missing = missingAnchors(record, roots[record.project]).filter((p) => !seen.has(p));
    if (missing.length) flags.push({ kind: 'anchor', missing });
    if (isStale(record, today)) flags.push({ kind: 'stale', since: checkedOn(record) });
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
    });
  }
  const rank = (item) => Math.min(...item.flags.map((f) => FLAG_ORDER.indexOf(f.kind)));
  items.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  return { items: items.slice(0, MAX_ITEMS), total: items.length };
}

/** The confirmed memory with this key, or a reason. */
function findConfirmed(dir, key) {
  if (!splitKey(key)) return { reason: 'bad-key' };
  const found = scan(dir).records.find(([k]) => k === key);
  if (!found) return { reason: 'not-found' };
  return found[1].confidence === 'confirmed' ? { record: found[1] } : { reason: 'not-confirmed' };
}

/**
 * The user says a confirmed memory is still true: its flags clear.
 * @param {string} dir the mirror folder
 * @param {string} key
 * @param {string} today YYYY-MM-DD
 * @param {{log?: {add: Function}, roots?: object}} [opts]
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function verify(dir, key, today, { log = null, roots = {} } = {}) {
  const found = findConfirmed(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  const { record } = found;
  writeRecord(dir, { ...record, last_verified: today });
  // The files missing today were seen and accepted: they are not flagged again.
  if (log) log.add({ ev: 'verified', key, by: 'user', missing: missingAnchors(record, roots[record.project]) });
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
  reviewList,
  verify,
  retire,
  toolVerdict,
  STALE_DAYS,
  STALE_TYPES,
  DIGEST_DAYS,
  REVERIFY_DAYS,
  MAX_ITEMS,
};
