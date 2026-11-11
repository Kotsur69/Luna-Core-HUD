// ============================================================================
// LunaCore - the memory inbox: what waits for Mati's approval (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4 (section 7 step 4, decisions
// 5, 11 and 17). There is no separate inbox store. A memory that is not
// `confirmed` IS an inbox entry: capture (src/memorycapture.js) saves its
// candidates as `observed` memories in the mirror, so they are searchable at
// once, they sync like every other memory, and a candidate captured on one PC
// can be approved on the other.
//
//   approve  confidence -> confirmed, last_verified -> today. From then on the
//            memory is on the project card and its `supersedes` takes effect.
//   reject   the file is deleted (a tombstone for the other PCs).
//   update   title, body, type or area are corrected; it stays in the inbox.
//
// Two PCs can propose the same memory from different sessions. Near-duplicates
// among the waiting entries are shown as ONE entry; approving or rejecting it
// removes the others.
//
// No Electron here: scripts/luna.js uses the same functions with the app closed.
// ============================================================================

'use strict';

const { GLOBAL, TYPES, checkRecord, splitKey, keyOf } = require('./memoryrecord');
const { scan, writeRecord, removeRecord } = require('./memorystore');
const { nearDuplicate } = require('./memoryextract');

/** Entries one listing returns; the count says how many wait in all. */
const MAX_ITEMS = 100;

const isPending = (record) => record.confidence !== 'confirmed';
/** Oldest first; the key settles a tie so every PC picks the same lead of a group. */
const byAge = ([ka, a], [kb, b]) => a.created.localeCompare(b.created) || ka.localeCompare(kb);

/**
 * The waiting entries, near-duplicates folded into the oldest of them.
 * @param {[string, object][]} records [key, record] from memorystore.scan()
 * @returns {{key: string, record: object, duplicates: string[]}[]} oldest first
 */
function groupPending(records) {
  const groups = [];
  for (const [key, record] of records.filter(([, r]) => isPending(r)).sort(byAge)) {
    const lead = groups.find((g) => g.record.project === record.project && nearDuplicate(g.record, record));
    if (lead) lead.duplicates.push(key);
    else groups.push({ key, record, duplicates: [] });
  }
  return groups;
}

/** A confirmed memory of the same project (or a global one) that says nearly the same. */
function similarConfirmed(records, record) {
  const replaced = new Set(record.supersedes);
  const hit = records.find(
    ([, r]) =>
      !isPending(r) &&
      (r.project === record.project || r.project === GLOBAL) &&
      !(r.project === record.project && replaced.has(r.id)) &&
      nearDuplicate(r, record),
  );
  return hit ? { key: hit[0], title: hit[1].title } : null;
}

/**
 * @param {string} dir the mirror folder (memoryPaths().dir)
 * @returns {{items: object[], total: number}} newest first; total = entries waiting, duplicates folded
 */
function listInbox(dir) {
  const { records } = scan(dir);
  const byKey = new Map(records);
  const groups = groupPending(records).reverse();
  const items = groups.slice(0, MAX_ITEMS).map(({ key, record, duplicates }) => ({
    key,
    project: record.project,
    id: record.id,
    type: record.type,
    ...(record.area ? { area: record.area } : {}),
    title: record.title,
    body: record.body,
    created: record.created,
    source: record.source || null,
    // What approving this entry would replace.
    supersedes: record.supersedes
      .map((id) => byKey.get(`${record.project}/${id}`))
      .filter(Boolean)
      .map((r) => ({ id: r.id, title: r.title })),
    duplicates: duplicates.length,
    similar: similarConfirmed(records, record),
  }));
  return { items, total: groups.length };
}

/** How many entries wait for one project (its own, not the global ones). */
function pendingCount(dir, project) {
  return groupPending(scan(dir).records).filter((g) => g.record.project === project).length;
}

/** The waiting entry with this key and the duplicates folded into it, or a reason. */
function findPending(dir, key) {
  if (!splitKey(key)) return { reason: 'bad-key' };
  const { records } = scan(dir);
  const found = records.find(([k]) => k === key);
  if (!found) return { reason: 'not-found' };
  if (!isPending(found[1])) return { reason: 'not-pending' };
  // The entry may be a folded duplicate itself: act on the whole group it is in.
  const group = groupPending(records).find((g) => g.key === key || g.duplicates.includes(key));
  const others = [group.key, ...group.duplicates].filter((k) => k !== key);
  return { record: found[1], others };
}

/**
 * Approves one entry.
 * @param {string} dir
 * @param {string} key
 * @param {string} today YYYY-MM-DD
 * @param {(event: string, record: object) => void} [decided] called once the
 *   decision is on disk, with 'approved' and the entry as it was (phase 5: the memory log)
 * @returns {{ok: true, key: string, removed: string[]}|{ok: false, reason: string}}
 */
function approve(dir, key, today, decided = () => {}) {
  const found = findPending(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  writeRecord(dir, { ...found.record, confidence: 'confirmed', last_verified: today });
  for (const other of found.others) removeRecord(dir, other);
  decided('approved', found.record);
  return { ok: true, key, removed: found.others };
}

/**
 * Rejects one entry: it and its duplicates are deleted.
 * @param {(event: string, record: object) => void} [decided] called with 'rejected' and the deleted entry
 * @returns {{ok: true, key: string, removed: string[]}|{ok: false, reason: string}}
 */
function reject(dir, key, decided = () => {}) {
  const found = findPending(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  for (const k of [key, ...found.others]) removeRecord(dir, k);
  decided('rejected', found.record);
  return { ok: true, key, removed: found.others };
}

/**
 * Corrects a waiting entry. It stays unconfirmed.
 * @param {string} dir
 * @param {string} key
 * @param {{title?: unknown, body?: unknown, type?: unknown, area?: unknown}} edits
 *   area: '' or null removes the tag
 * @param {(event: string, record: object) => void} [decided] called with 'edited' and the corrected entry
 * @returns {{ok: true, key: string}|{ok: false, reason: string}} reason = the field that failed (memoryrecord.checkRecord)
 */
function update(dir, key, edits, decided = () => {}) {
  const found = findPending(dir, key);
  if (!found.record) return { ok: false, reason: found.reason };
  const e = edits && typeof edits === 'object' && !Array.isArray(edits) ? edits : {};
  const { area: oldArea, ...rest } = found.record;
  const area = e.area === undefined ? oldArea : e.area || undefined;
  const res = checkRecord({
    ...rest,
    ...(area ? { area } : {}),
    ...(e.title !== undefined ? { title: e.title } : {}),
    ...(e.body !== undefined ? { body: e.body } : {}),
    ...(e.type !== undefined ? { type: e.type } : {}),
  });
  if (!res.record) return { ok: false, reason: res.error };
  if (keyOf(res.record) !== key) return { ok: false, reason: 'bad-key' };
  writeRecord(dir, res.record);
  decided('edited', res.record);
  return { ok: true, key };
}

module.exports = { listInbox, pendingCount, approve, reject, update, groupPending, isPending, TYPES, MAX_ITEMS };
