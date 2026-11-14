// ============================================================================
// LunaCore - where one memory came from and what happened to it (main, pure)
// ----------------------------------------------------------------------------
// The 'History' expander of the memory window's list of all memories
// (renderer memoryhistory.js, through memory:provenance in
// src/memorybrainipc.js). Read only. For one memory it gathers:
//
//   source     its `source` line read apart: a session or a God Mode run, the
//              machine, the outside-content note, 'suggested global'
//   chain      what it supersedes, recursively, and what superseded it, both
//              cut at MAX_CHAIN_DEPTH levels; the memories named need not exist
//              any more (a rejected one is deleted), and then have no title
//   refs       its links, conflicts and compatible memories, with titles
//   timeline   its events in THIS PC's memory log (the log is not synced):
//              proposed, approved, edited, ..., conflict, merged; reads are
//              counted, not listed, as there can be hundreds
//
// Everything returned is plain data; the renderer shows it with textContent.
// ============================================================================

'use strict';

const { GLOBAL, scoreOf } = require('./memoryrecord');
const { sourceNotes } = require('./memoryextract');

/** How many levels of the chain are followed each way. */
const MAX_CHAIN_DEPTH = 5;
/** Memories one direction of the chain may name in all (each level can hold 20). */
const MAX_CHAIN_NODES = 60;
/** Timeline events returned, the newest ones; `total` says how many there are. */
const MAX_TIMELINE = 60;

/** Log events about the memory itself, shown as they are. */
const OWN_EVENTS = new Set(['proposed', 'approved', 'edited', 'rejected', 'retired', 'auto-accepted', 'superseded', 'restored', 'verified', 'disputed']);

/** The sources LunaCore writes, read apart; anything else is shown as its text alone. */
const SOURCE_FORMS = [
  { kind: 'session', re: /^captured from session ([A-Za-z0-9-]+) on (.+?)(?:, |$)/ },
  { kind: 'session', re: /^proposed in session ([A-Za-z0-9-]+) on (.+?)(?:, |$)/ },
  { kind: 'godmode', re: /^captured from God Mode run (\S+) on (.+?)(?:, |$)/ },
  { kind: 'merged', re: /^merged by hand from ([a-z0-9-]+) and ([a-z0-9-]+)/ },
  { kind: 'auto-memory', re: /^claude auto-memory(?:, session ([A-Za-z0-9-]+))?/ },
];
const AUTO_ACCEPTED_NOTE = ', auto-accepted';

/**
 * A memory's source line read apart.
 * @param {string|null|undefined} source
 * @returns {{text: string, kind: 'session'|'godmode'|'merged'|'auto-memory'|'other'|null,
 *   ref: string|null, machine: string|null, outside: number, suggestedGlobal: boolean, autoAccepted: boolean}}
 *   kind null = the memory has no source (written by hand); ref = the session or run id
 */
function sourceOf(source) {
  const text = typeof source === 'string' ? source : '';
  const notes = sourceNotes(text);
  const base = { text, outside: notes.outside, suggestedGlobal: notes.suggestedGlobal, autoAccepted: text.includes(AUTO_ACCEPTED_NOTE) };
  if (!text) return { ...base, kind: null, ref: null, machine: null };
  for (const { kind, re } of SOURCE_FORMS) {
    const m = re.exec(text);
    if (!m) continue;
    if (kind === 'merged') return { ...base, kind, ref: `${m[1]}, ${m[2]}`, machine: null };
    return { ...base, kind, ref: m[1] || null, machine: m[2] || null };
  }
  return { ...base, kind: 'other', ref: null, machine: null };
}

/** id -> {id, key, title|null}: the project's memory, else a global one, else a name with no title. */
function refOf(byKey, project, id) {
  for (const key of [`${project}/${id}`, `${GLOBAL}/${id}`]) {
    const r = byKey.get(key);
    if (r) return { id, key, title: r.title };
  }
  return { id, key: `${project}/${id}`, title: null };
}

/**
 * One direction of the chain as a tree, MAX_CHAIN_DEPTH levels deep.
 * @param {string} key the memory the tree starts from (not part of it)
 * @param {(key: string) => string[]} next the keys one step further
 * @param {Map<string, object>} byKey
 * @returns {{nodes: object[], cut: boolean}} node = {key, id, title|null, confirmed|null, children};
 *   cut = something was left out (deeper than the cap, or past the node cap). A loop
 *   (a hand-edited file) stops where it closes; a memory two branches share is shown in both.
 */
function chainTree(key, next, byKey) {
  let count = 0;
  let cut = false;
  const grow = (from, depth, path) => {
    const nodes = [];
    for (const k of next(from)) {
      if (path.has(k)) continue;
      if (count >= MAX_CHAIN_NODES) {
        cut = true;
        break;
      }
      count++;
      const r = byKey.get(k);
      const node = { key: k, id: k.slice(k.lastIndexOf('/') + 1), title: r ? r.title : null, confirmed: r ? r.confidence === 'confirmed' : null, children: [] };
      if (depth < MAX_CHAIN_DEPTH) node.children = grow(k, depth + 1, new Set([...path, k]));
      else if (next(k).some((n) => !path.has(n) && n !== k)) cut = true;
      nodes.push(node);
    }
    return nodes;
  };
  return { nodes: grow(key, 1, new Set([key])), cut };
}

/** One log event as the timeline shows it, or null when it is not about this memory. */
function timelineEvent(e, key) {
  if (OWN_EVENTS.has(e.ev) && e.key === key) {
    return { at: e.at, ev: e.ev, ...(e.by ? { by: e.by } : {}), ...(e.note ? { note: e.note } : {}) };
  }
  if (e.ev === 'conflict' && (e.key === key || e.other === key)) {
    return { at: e.at, ev: e.ev, other: e.key === key ? e.other : e.key, ...(e.note ? { note: e.note } : {}) };
  }
  if (e.ev === 'merged' && e.key === key) return { at: e.at, ev: e.ev, from: e.from };
  if (e.ev === 'merged' && Array.isArray(e.from) && e.from.includes(key)) return { at: e.at, ev: e.ev, into: e.key };
  return null;
}

/**
 * This PC's log about one memory.
 * @returns {{events: object[], total: number, reads: {found: number, opened: number, last: number|null}}}
 *   events oldest first, the newest MAX_TIMELINE of them
 */
function timelineOf(events, key) {
  const list = [];
  const reads = { found: 0, opened: 0, last: null };
  const read = (at, field) => {
    reads[field]++;
    reads.last = Math.max(reads.last || 0, at);
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.ev === 'search' && Array.isArray(e.hits) && e.hits.includes(key)) read(e.at, 'found');
    else if (e.ev === 'get' && e.key === key) read(e.at, 'opened');
    else {
      const item = timelineEvent(e, key);
      if (item) list.push(item);
    }
  }
  list.sort((x, y) => x.at - y.at);
  return { events: list.slice(-MAX_TIMELINE), total: list.length, reads };
}

/**
 * Everything the History expander shows about one memory.
 * @param {[string, object][]} records memorystore.scan().records
 * @param {object[]} events this PC's memory log (memorylog.readLog)
 * @param {string} key a checked key
 * @returns {{ok: true, ...}|{ok: false, reason: 'not-found'}}
 */
function provenance(records, events, key) {
  const byKey = new Map(records);
  const r = byKey.get(key);
  if (!r) return { ok: false, reason: 'not-found' };
  // Who replaced whom: old key -> the keys of the memories that name it in `supersedes`.
  const supersededBy = new Map();
  for (const [k, other] of records) {
    for (const old of other.supersedes) {
      const oldKey = `${other.project}/${old}`;
      supersededBy.set(oldKey, [...(supersededBy.get(oldKey) || []), k]);
    }
  }
  const down = (k) => {
    const rec = byKey.get(k);
    return rec ? rec.supersedes.map((id) => `${rec.project}/${id}`) : [];
  };
  const up = (k) => [...(supersededBy.get(k) || [])].sort();
  const refs = (field) => (r[field] || []).map((id) => refOf(byKey, r.project, id));
  return {
    ok: true,
    key,
    id: r.id,
    project: r.project,
    type: r.type,
    title: r.title,
    confidence: r.confidence,
    created: r.created,
    last_verified: r.last_verified || null,
    last_used: r.last_used || null,
    archived: r.archived || null,
    ...scoreOf(r),
    source: sourceOf(r.source),
    supersedes: chainTree(key, down, byKey),
    supersededBy: chainTree(key, up, byKey),
    links: refs('links'),
    conflicts: refs('conflicts'),
    compatible: refs('compatible'),
    // The log is per PC: the window says so next to the timeline.
    timeline: timelineOf(events, key),
  };
}

module.exports = { provenance, sourceOf, timelineOf, chainTree, MAX_CHAIN_DEPTH, MAX_CHAIN_NODES, MAX_TIMELINE };
