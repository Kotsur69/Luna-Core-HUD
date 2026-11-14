// ============================================================================
// LunaCore - memories that contradict each other, and settling them (main + CLI)
// ----------------------------------------------------------------------------
// Two memories of the same project that say opposite things are worse than
// one: a session cannot tell which to trust. A conflict is found two ways:
//
//   scan   the usefulness scan (src/memoryscan.js) names the pair; the first
//          memory's `conflicts` field keeps the other's id, so the conflict
//          syncs to every PC like the inbox does (decision 11).
//   check  a cheap test over titles: the same topic words, and only one of
//          the two says "not / never / avoid ...". No model call.
//
// The inbox shows each pair once, with three choices:
//
//   keep A   A supersedes B: B's id joins A's `supersedes`. A becomes
//            confirmed if it was still waiting (Mati chose it, which is the
//            approval decision 5 asks for). B's file stays as it is: a
//            superseded memory is history (decision 12), left off the card,
//            out of search and out of the inbox, never silently deleted.
//   keep B   the same the other way round.
//   keep both  A's `compatible` keeps B's id: the pair is not shown again,
//            by either way of finding it.
//
// Merge suggestions ride in the same list: two CONFIRMED memories of one
// project that say nearly the same thing (memoryextract.nearDuplicate), not
// already a conflict and not marked compatible. They take the same three
// choices, and both kinds of pair take a fourth:
//
//   merge    Mati writes one memory from the two (the inbox edit form,
//            prefilled). It is saved confirmed (he wrote it) with both ids in
//            its `supersedes`; both originals stay on disk as history
//            (decision 12). The log gets `merged`, and `superseded` per original.
//
// Only a pair that is listed right now can be settled, so the renderer cannot
// use this to supersede an arbitrary memory.
// ============================================================================

'use strict';

const { splitKey, scoreOf, checkRecord, keyOf } = require('./memoryrecord');
const { scan, writeRecord } = require('./memorystore');
const { supersededKeys } = require('./memoryreview');
const { duplicateWords, sameWords, idFor, sourceNotes, outsideNote, withNote } = require('./memoryextract');

const KEEP = ['a', 'b', 'both'];
/** Pairs one listing returns; the total says how many there are. */
const MAX_ITEMS = 50;
/** memoryrecord keeps at most this many ids in a list field. */
const MAX_REFS = 20;
/** The cheap check: at least this many shared topic words ... */
const MIN_SHARED_TOPIC_WORDS = 2;
/** ... making up at least this share of the shorter title's topic words. */
const TOPIC_OVERLAP = 0.6;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'is', 'it', 'be', 'so', 'do', 'does',
  'with', 'that', 'this', 'from', 'are', 'was', 'when', 'into', 'its', 'has', 'have', 'you', 'should', 'must', 'always',
]);
/** Apostrophes are dropped before the words are cut: "don't" reads as "dont". */
const NEGATIONS = new Set([
  'not', 'never', 'no', 'nor', 'avoid', 'stop', 'forbid', 'forbidden', 'cannot', 'cant', 'dont', 'doesnt', 'isnt', 'arent',
  'mustnt', 'shouldnt', 'wont', 'without',
]);

const errText = (err) => (err && (err.code || err.message)) || 'error';
/** One id for a pair, whichever way round it is named. Keys never hold '|'. */
const pairId = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const union = (list, id) => [...new Set([...(list || []), id])];
const without = (list, id) => (list || []).filter((x) => x !== id);

/** A title's topic words and whether it says "not". */
function topicOf(title) {
  const words = String(title || '').toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}_]+/gu) || [];
  return {
    negated: words.some((w) => NEGATIONS.has(w)),
    topic: new Set(words.filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !NEGATIONS.has(w))),
  };
}

/** The cheap check: the same topic, opposite polarity. */
function opposing(a, b) {
  if (a.negated === b.negated) return false;
  const smaller = Math.min(a.topic.size, b.topic.size);
  if (!smaller) return false;
  let shared = 0;
  for (const w of a.topic) if (b.topic.has(w)) shared++;
  return shared >= MIN_SHARED_TOPIC_WORDS && shared / smaller >= TOPIC_OVERLAP;
}

const compatiblePair = (ra, rb) => (ra.compatible || []).includes(rb.id) || (rb.compatible || []).includes(ra.id);

/** Records that can be in a conflict: not superseded, not archived. */
function activeRecords(records) {
  const gone = supersededKeys(records);
  return records.filter(([key, r]) => !gone.has(key) && !r.archived);
}

/**
 * Every open conflict.
 * @param {[string, object][]} records memorystore.scan().records
 * @returns {{id: string, a: string, b: string, source: 'scan'|'check'}[]} by id; a < b
 */
function findConflicts(records) {
  const active = activeRecords(records);
  const byKey = new Map(active);
  const pairs = new Map();
  const add = (ka, kb, source) => {
    const ra = byKey.get(ka);
    const rb = byKey.get(kb);
    if (ka === kb || !ra || !rb || ra.project !== rb.project || compatiblePair(ra, rb)) return;
    const id = pairId(ka, kb);
    if (pairs.has(id)) return;
    const [a, b] = id.split('|');
    pairs.set(id, { id, a, b, source });
  };
  for (const [key, r] of active) for (const other of r.conflicts || []) add(key, `${r.project}/${other}`, 'scan');
  const byProject = new Map();
  for (const [key, r] of active) byProject.set(r.project, [...(byProject.get(r.project) || []), [key, topicOf(r.title)]]);
  for (const list of byProject.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) if (opposing(list[i][1], list[j][1])) add(list[i][0], list[j][0], 'check');
    }
  }
  return [...pairs.values()].sort((x, y) => x.id.localeCompare(y.id));
}

/**
 * Merge suggestions: near-duplicate pairs of confirmed memories of one project.
 * A pair marked compatible ('keep both') never comes back.
 * @param {[string, object][]} records
 * @returns {{id: string, a: string, b: string, source: 'duplicate'}[]} by id; a < b
 */
function findDuplicates(records) {
  const byProject = new Map();
  for (const [key, r] of activeRecords(records)) {
    if (r.confidence !== 'confirmed') continue;
    byProject.set(r.project, [...(byProject.get(r.project) || []), { key, r, words: duplicateWords(r) }]);
  }
  const pairs = [];
  for (const list of byProject.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [x, y] = [list[i], list[j]];
        if (compatiblePair(x.r, y.r) || !sameWords(x.words, y.words)) continue;
        const id = pairId(x.key, y.key);
        const [a, b] = id.split('|');
        pairs.push({ id, a, b, source: 'duplicate' });
      }
    }
  }
  return pairs.sort((x, y) => x.id.localeCompare(y.id));
}

/** Every pair the inbox lists: conflicts first, then the merge suggestions that are no conflict. */
function findPairs(records) {
  const conflicts = findConflicts(records);
  const known = new Set(conflicts.map((p) => p.id));
  return [...conflicts, ...findDuplicates(records).filter((p) => !known.has(p.id))];
}

/** The scan's reason per pair, newest last wins, from the memory log. */
function conflictNotes(events) {
  const notes = new Map();
  for (const e of events) if (e.ev === 'conflict') notes.set(pairId(e.key, e.other), e.note || '');
  return notes;
}

function side(key, r) {
  return { key, id: r.id, project: r.project, type: r.type, title: r.title, body: r.body, confidence: r.confidence, created: r.created, ...scoreOf(r) };
}

/**
 * The inbox's conflict entries and merge suggestions (source 'duplicate').
 * @param {[string, object][]} records
 * @param {{events?: object[]}} [opts] events = the memory log (the scan's reasons)
 * @returns {{items: object[], total: number}}
 */
function listConflicts(records, { events = [] } = {}) {
  const byKey = new Map(records);
  const notes = conflictNotes(events);
  const pairs = findPairs(records);
  const items = pairs.slice(0, MAX_ITEMS).map((p) => ({
    id: p.id,
    source: p.source,
    note: notes.get(p.id) || null,
    a: side(p.a, byKey.get(p.a)),
    b: side(p.b, byKey.get(p.b)),
  }));
  return { items, total: pairs.length };
}

/**
 * How many conflicts wait (the hub counts them with the inbox). Never throws.
 * Merge suggestions are left out on purpose: two memories that agree are
 * tidying, not a decision the hub should call Mati back for.
 */
function conflictCount(dir) {
  try {
    return findConflicts(scan(dir).records).length;
  } catch (err) {
    console.error('[memory] conflict count failed:', errText(err));
    return 0;
  }
}

/**
 * Writes the pairs the scan named into the first memory's `conflicts`.
 * @param {string} dir
 * @param {string} project
 * @param {{a: string, b: string, reason: string}[]} pairs ids of that project
 * @param {{log?: {add: Function}}} [opts]
 * @returns {number} pairs newly marked
 */
function markConflicts(dir, project, pairs, { log = null } = {}) {
  const records = scan(dir).records;
  const gone = supersededKeys(records);
  const byKey = new Map(records);
  let marked = 0;
  for (const { a, b, reason } of pairs) {
    const ka = `${project}/${a}`;
    const kb = `${project}/${b}`;
    const ra = byKey.get(ka);
    const rb = byKey.get(kb);
    if (ka === kb || !ra || !rb || gone.has(ka) || gone.has(kb) || ra.archived || rb.archived || compatiblePair(ra, rb)) continue;
    if ((ra.conflicts || []).includes(b) || (rb.conflicts || []).includes(a) || (ra.conflicts || []).length >= MAX_REFS) continue;
    try {
      const next = { ...ra, conflicts: union(ra.conflicts, b) };
      writeRecord(dir, next);
      byKey.set(ka, next);
      marked++;
      if (log) log.add({ ev: 'conflict', key: ka, other: kb, note: reason });
    } catch (err) {
      console.error('[memory] conflict not marked:', errText(err));
    }
  }
  return marked;
}

/**
 * Settles one listed conflict.
 * @param {string} dir
 * @param {{a: string, b: string, keep: 'a'|'b'|'both'}} choice a and b are keys, as listed
 * @param {string} today YYYY-MM-DD
 * @param {{log?: {add: Function}}} [opts]
 * @returns {{ok: true, kept: string[], superseded?: string}|{ok: false, reason: string}}
 */
function resolveConflict(dir, { a, b, keep }, today, { log = null } = {}) {
  if (!splitKey(a) || !splitKey(b) || a === b) return { ok: false, reason: 'bad-key' };
  if (!KEEP.includes(keep)) return { ok: false, reason: 'bad-keep' };
  const { records } = scan(dir);
  if (!findPairs(records).some((p) => p.id === pairId(a, b))) return { ok: false, reason: 'not-conflict' };
  const byKey = new Map(records);
  const ra = byKey.get(a);
  const rb = byKey.get(b);
  if (keep === 'both') {
    if ((ra.compatible || []).length >= MAX_REFS) return { ok: false, reason: 'too-many' };
    writeRecord(dir, { ...ra, compatible: union(ra.compatible, rb.id), conflicts: without(ra.conflicts, rb.id) });
    if ((rb.conflicts || []).includes(ra.id)) writeRecord(dir, { ...rb, conflicts: without(rb.conflicts, ra.id) });
    return { ok: true, kept: [a, b] };
  }
  const [winKey, winner, loseKey, loser] = keep === 'a' ? [a, ra, b, rb] : [b, rb, a, ra];
  if (winner.supersedes.length >= MAX_REFS) return { ok: false, reason: 'too-many' };
  writeRecord(dir, {
    ...winner,
    confidence: 'confirmed',
    ...(winner.confidence === 'confirmed' ? {} : { last_verified: today }),
    supersedes: union(winner.supersedes, loser.id),
    conflicts: without(winner.conflicts, loser.id),
  });
  if (log) log.add({ ev: 'superseded', key: loseKey, type: loser.type, title: loser.title });
  return { ok: true, kept: [winKey], superseded: loseKey };
}

/** The best usefulness score of the two, with its note and date, or nothing. */
function bestScore(records) {
  const best = records.filter((r) => Number.isInteger(r.usefulness)).sort((x, y) => y.usefulness - x.usefulness)[0];
  if (!best) return {};
  return {
    usefulness: best.usefulness,
    ...(best.usefulness_note ? { usefulness_note: best.usefulness_note } : {}),
    ...(best.usefulness_at ? { usefulness_at: best.usefulness_at } : {}),
  };
}

/**
 * Merges one listed pair into a new memory Mati wrote: confirmed, superseding
 * both. The originals are not touched: superseded, they are history.
 * @param {string} dir
 * @param {{a: string, b: string, title: unknown, body: unknown}} merge a and b are keys, as listed;
 *   title and body are the edit form's text, checked by checkRecord like any record
 * @param {string} today YYYY-MM-DD
 * @param {{log?: {add: Function}}} [opts]
 * @returns {{ok: true, key: string, superseded: string[]}|{ok: false, reason: string}}
 */
function mergePair(dir, { a, b, title, body }, today, { log = null } = {}) {
  if (!splitKey(a) || !splitKey(b) || a === b) return { ok: false, reason: 'bad-key' };
  const { records } = scan(dir);
  if (!findPairs(records).some((p) => p.id === pairId(a, b))) return { ok: false, reason: 'not-conflict' };
  const byKey = new Map(records);
  const ra = byKey.get(a);
  const rb = byKey.get(b);
  // Every file of the project counts as taken, the superseded ones too: they stay on disk.
  const taken = new Set(records.map(([k]) => k));
  const id = (typeof title === 'string' && idFor(title, ra.project, taken)) || idFor(`${ra.id} merged`, ra.project, taken);
  if (!id) return { ok: false, reason: 'id-taken' };
  const res = checkRecord({
    id,
    type: ra.type,
    project: ra.project,
    ...(ra.area ? { area: ra.area } : {}),
    title,
    created: today,
    last_verified: today,
    // Text drawn from a session that read web or MCP content keeps saying so (auto-accept and review read it).
    source: withNote(`merged by hand from ${ra.id} and ${rb.id}`, outsideNote(Math.max(sourceNotes(ra.source).outside, sourceNotes(rb.source).outside))),
    confidence: 'confirmed',
    ...bestScore([ra, rb]),
    supersedes: [ra.id, rb.id],
    links: [...ra.links, ...rb.links].filter((x) => x !== ra.id && x !== rb.id),
    body,
  });
  if (!res.record) return { ok: false, reason: res.error };
  writeRecord(dir, res.record);
  const key = keyOf(res.record);
  if (log) {
    log.add({ ev: 'merged', key, type: res.record.type, title: res.record.title, from: [a, b] });
    for (const [k, r] of [[a, ra], [b, rb]]) log.add({ ev: 'superseded', key: k, type: r.type, title: r.title });
  }
  return { ok: true, key, superseded: [a, b] };
}

module.exports = {
  findConflicts,
  findDuplicates,
  findPairs,
  mergePair,
  listConflicts,
  conflictCount,
  markConflicts,
  resolveConflict,
  topicOf,
  opposing,
  pairId,
  KEEP,
  MIN_SHARED_TOPIC_WORDS,
  TOPIC_OVERLAP,
};
