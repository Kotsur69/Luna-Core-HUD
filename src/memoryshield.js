// ============================================================================
// LunaCore - the Rejected-Embedding Shield, and semantic capture dedup (main + CLI)
// ----------------------------------------------------------------------------
// A memory Mati rejected in the inbox, or an auto-accept he undid, tends to
// come back in other words from the next session. Its title is fed back to the
// extractor as "not wanted" (memorylog.rejectedTitles), but a model does not
// always listen. The shield remembers what a rejected memory MEANT: its vector
// of the local embedding model (src/memoryembed.js), next to its title:
//
//   memory-rejected-vectors.local.json   (next to memory-vectors.local.json)
//   {"v": 1, "model", "dim", "entries": [{"at": <ms>, "project", "title", "vec": <base64>}]}
//
// Oldest first, at most MAX_REJECTED_VECTORS: the oldest go first. The file is
// LOCAL and never synced, like the vector cache (decision 9): each PC embeds
// with its own model, and vectors of two models never mix, so a new model
// starts the file over. A title is run through the secret scrub before it is
// written. The body is not kept, only the vector of title and body, as the
// vector cache keeps one per memory; a fresh embed is of the scrubbed text.
// Rejecting the same memory again replaces its entry. Approving a memory
// forgets the entries it is within REJECTED_SIMILAR of (forgetSimilar): Mati
// said yes to that meaning after all.
//
// The file can be edited by anyone. A row that does not check out is skipped;
// a file that cannot be parsed is moved aside to <file>.broken on the next
// write, never silently overwritten; a file the disk cannot read right now
// (locked) is left alone and that one rejection is not remembered.
//
// Capture (src/memorycapture.js, src/memoryruncapture.js) embeds its candidates
// when LM Studio serves the model of the stored vectors (semanticCandidates):
//   - near-duplicates are found by meaning (memoryextract.nearDuplicate),
//   - a kept candidate within REJECTED_SIMILAR (cosine) of a rejected memory of
//     the same project (or a global one) is dropped as SIMILAR_REJECTED: the
//     graveyard keeps it as "similar to rejected: <title>" (src/memorygraveyard.js),
//     restorable by hand like any other entry. A candidate that supersedes a
//     memory is a correction and is never shielded: Mati decides in the inbox.
// Without the model, or without vectors, capture is exactly the word-based
// filter it was: no error, no wait beyond the embedder's cached "no model".
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { GLOBAL, MAX_TITLE } = require('./memoryrecord');
const { scrub } = require('./hostscrub');
const { candidatesFrom, DUPLICATE } = require('./memoryextract');
const { cosine, docText, encodeVector, decodeVector, vectorLookup, MAX_DIM } = require('./memoryembed');

const REJECTED_VECTORS_FILE = 'memory-rejected-vectors.local.json';
const FILE_VERSION = 1;
/** Rejected memories remembered; the oldest go first. */
const MAX_REJECTED_VECTORS = 500;
/** A candidate at least this close (cosine) to a rejected memory is buried, not proposed. */
const REJECTED_SIMILAR = 0.8;
/** The rejection reason of a shielded candidate; it carries `similarTo` (the rejected title) and its record. */
const SIMILAR_REJECTED = 'similar to rejected';
/** Rows read from the file at most, valid or not: a hand-grown file cannot make a read slow. */
const MAX_RAW_ROWS = MAX_REJECTED_VECTORS * 2;
/** Two entries of one project this close are the same rejection: the newer replaces the older. */
const SAME_ENTRY = 0.99;
/** A file past this size is not read: it is moved aside on the next write (500 vectors of 8192 floats fit easily). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_CHARS = 200;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err && (err.code || err.message)) || 'error';
/** The shield file of a folder: the vector store's own (store.dir), i.e. the user config folder. */
const rejectedVectorsPath = (dir) => path.join(dir, REJECTED_VECTORS_FILE);

/** A title as the shield keeps it: secrets masked, one line, at most MAX_TITLE characters. */
function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  return scrub(raw)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

const cleanProject = (raw) => (typeof raw === 'string' && raw && raw.length <= MAX_PROJECT_CHARS ? raw : '');

/**
 * The shield file -> {model, entries}, oldest first. A missing or hand-edited
 * file is read as far as it is valid; never throws.
 * @param {string} file rejectedVectorsPath(dir)
 * @returns {{model: string|null, entries: {at: number, project: string, title: string, vec: Float32Array}[], state: 'ok'|'broken'|'locked'}}
 *   state: 'broken' = the file is there but is no shield file (addRejected moves it aside),
 *   'locked' = the disk cannot read it right now (addRejected leaves it alone)
 */
function readRejected(file) {
  const empty = (state) => ({ model: null, entries: [], state });
  let doc = null;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('too large');
    doc = readDoc(file);
  } catch (err) {
    if (err.code === 'ENOENT') return empty('ok');
    console.error('[memory] rejected vectors unreadable:', errText(err));
    // A file system error (EBUSY, EPERM ...) carries a code; bad content (JSON, size) does not.
    return empty(err.code ? 'locked' : 'broken');
  }
  const { v, model, dim, entries } = isObject(doc) ? doc : {};
  if (v !== FILE_VERSION || typeof model !== 'string' || !model || !Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) return empty('broken');
  // Oldest first: a hand-grown list keeps its newest valid entries.
  const rows = Array.isArray(entries) ? entries.slice(-MAX_RAW_ROWS) : [];
  const kept = [];
  for (const row of rows) {
    if (!isObject(row) || !Number.isFinite(row.at)) continue;
    const title = cleanTitle(row.title);
    const project = cleanProject(row.project);
    const vec = decodeVector(row.vec, dim);
    if (title && project && vec) kept.push({ at: row.at, project, title, vec });
  }
  return { model, entries: kept.slice(-MAX_REJECTED_VECTORS), state: 'ok' };
}

/**
 * The entries of the file as a write may build on them: a broken file is moved
 * aside to <file>.broken first, so a hand-edit with a typo is never lost.
 * @throws when the file cannot be read right now (the caller skips this write)
 */
function entriesToBuildOn(file) {
  const current = readRejected(file);
  if (current.state === 'locked') throw new Error('rejected vectors locked, not written');
  if (current.state === 'broken') {
    fs.renameSync(file, `${file}.broken`);
    console.error('[memory] rejected vectors moved aside to', `${path.basename(file)}.broken`);
  }
  return current;
}

/** Whether two entries are the same rejection: same project, and the same title or nearly the same vector. */
const sameEntry = (a, b) => a.project === b.project && (a.title.toLowerCase() === b.title.toLowerCase() || (cosine(a.vec, b.vec) || 0) >= SAME_ENTRY);

function writeRejected(file, { model, entries }) {
  const dim = entries.length ? entries[0].vec.length : 1;
  const rows = entries.map(({ at, project, title, vec }) => ({ at, project, title, vec: encodeVector(vec) }));
  writeAtomic(file, `${JSON.stringify({ v: FILE_VERSION, model, dim, entries: rows })}\n`);
}

/**
 * Adds one rejected memory; the oldest entries go past MAX_REJECTED_VECTORS.
 * A vector of another model than the file's starts the file over.
 * @param {string} file
 * @param {{model: string, project: string, title: string, vec: Float32Array, at: number}} entry
 * @returns {number} entries in the file afterwards; 0 = nothing written (an unusable entry)
 * @throws when the file cannot be written
 */
function addRejected(file, { model, project, title, vec, at }) {
  const clean = { at: Number.isFinite(at) ? at : Date.now(), project: cleanProject(project), title: cleanTitle(title), vec };
  const usable = typeof model === 'string' && model && clean.project && clean.title && vec instanceof Float32Array && vec.length >= 1 && vec.length <= MAX_DIM;
  if (!usable) return 0;
  const current = entriesToBuildOn(file);
  if (current.model && current.model !== model && current.entries.length) {
    console.error(`[memory] rejected vectors of ${current.model} dropped: the shield starts over with ${model}`);
  }
  const same = current.model === model ? current.entries.filter((e) => e.vec.length === vec.length && !sameEntry(e, clean)) : [];
  const entries = [...same, clean].slice(-MAX_REJECTED_VECTORS);
  writeRejected(file, { model, entries });
  return entries.length;
}

/**
 * Forgets the rejections a memory Mati approved is close to (same project or
 * global): he said yes to that meaning after all. Uses the cached vector only;
 * never asks the model and never throws.
 * @param {object|null} store the vector store
 * @param {object} record the approved memory
 * @returns {number} entries forgotten
 */
function forgetSimilar(store, record) {
  try {
    if (!store || !isObject(record) || typeof store.dir !== 'string') return 0;
    const vec = store.vectorFor(record);
    const model = store.model();
    if (!vec || !model) return 0;
    const file = rejectedVectorsPath(store.dir);
    const current = readRejected(file);
    if (current.state !== 'ok' || current.model !== model) return 0;
    const close = (e) => (e.project === record.project || e.project === GLOBAL) && (cosine(e.vec, vec) || 0) >= REJECTED_SIMILAR;
    const kept = current.entries.filter((e) => !close(e));
    if (kept.length === current.entries.length) return 0;
    writeRejected(file, { model, entries: kept });
    return current.entries.length - kept.length;
  } catch (err) {
    console.error('[memory] shield entries not forgotten:', errText(err));
    return 0;
  }
}

/**
 * The rejected memory closest to a vector, of the same project or global,
 * when it is at least REJECTED_SIMILAR close.
 * @param {{model: string|null, entries: object[]}} shield readRejected()
 * @param {{model: string, project: string, vec: ArrayLike<number>|undefined}} probe
 * @returns {{title: string, similarity: number}|null}
 */
function closestRejected(shield, { model, project, vec }) {
  if (!vec || !shield || shield.model !== model) return null;
  let best = null;
  for (const e of shield.entries) {
    if (e.project !== project && e.project !== GLOBAL) continue;
    const similarity = cosine(e.vec, vec);
    if (similarity !== null && similarity >= REJECTED_SIMILAR && (!best || similarity > best.similarity)) best = { title: e.title, similarity };
  }
  return best;
}

/**
 * Remembers a memory Mati rejected (or an auto-accept he undid). Uses the
 * cached vector when there is one, else embeds the memory when the model of
 * the stored vectors answers. Never throws: the decision is made already.
 * @param {object|null} store the vector store (memoryembed.createVectorStore); null = no shield
 * @param {object} record the rejected memory, as it was
 * @param {number} [now] ms
 * @returns {Promise<boolean>} whether it was remembered
 */
async function rememberRejected(store, record, now = Date.now()) {
  try {
    if (!store || !isObject(record) || !cleanTitle(record.title) || typeof store.dir !== 'string') return false;
    let vec = store.vectorFor(record);
    let model = store.model();
    if (!vec) {
      // Only a vector is kept, but it is made of the scrubbed text all the same.
      const res = await store.embedTexts([scrub(docText(record))]);
      if (!res) return false;
      [vec] = res.vectors;
      ({ model } = res);
    }
    if (!vec || !model) return false;
    return addRejected(rejectedVectorsPath(store.dir), { model, project: record.project, title: record.title, vec, at: now }) > 0;
  } catch (err) {
    console.error('[memory] rejected memory not remembered by the shield:', errText(err));
    return false;
  }
}

/**
 * Drops the kept candidates that mean what a rejected memory meant.
 * @param {{records: object[], rejected: object[]}} filtered candidatesFrom()'s answer
 * @param {{file: string, model: string, vectorOf: (record: object) => ArrayLike<number>|undefined}} ctx
 * @returns {{records: object[], rejected: object[]}} a shielded candidate moves to `rejected`
 *   as {title, reason: SIMILAR_REJECTED, type, usefulness, similarTo, record}; a candidate
 *   that supersedes a memory (a correction) is never shielded
 */
function shieldCandidates({ records, rejected }, { file, model, vectorOf }) {
  const shield = readRejected(file);
  if (!shield.entries.length || shield.model !== model) return { records, rejected };
  const kept = [];
  const dropped = [];
  for (const record of records) {
    const correction = Array.isArray(record.supersedes) && record.supersedes.length > 0;
    const hit = correction ? null : closestRejected(shield, { model, project: record.project, vec: vectorOf(record) });
    if (hit) dropped.push({ title: record.title, reason: SIMILAR_REJECTED, type: record.type, usefulness: record.usefulness, similarTo: hit.title, record });
    else kept.push(record);
  }
  return { records: kept, rejected: [...rejected, ...dropped] };
}

/**
 * candidatesFrom() by meaning, with the shield: the candidates the word-based
 * filter keeps or calls duplicates are embedded once, then filtered again with
 * their vectors. Without a store, a model, or vectors of the current model,
 * the answer is exactly candidatesFrom()'s. Never throws past candidatesFrom.
 * @param {unknown} answer the model's parsed answer
 * @param {object} ctx candidatesFrom's ctx (project, today, source, existing)
 * @param {object|null} store the vector store; null = by words only
 * @returns {Promise<{records: object[], rejected: object[]}>}
 */
async function semanticCandidates(answer, ctx, store) {
  const byWords = candidatesFrom(answer, ctx);
  if (!store) return byWords;
  const records = [...byWords.records, ...byWords.rejected.filter((r) => r.reason === DUPLICATE && isObject(r.record)).map((r) => r.record)];
  const texts = [...new Set(records.map(docText))];
  if (!texts.length) return byWords;
  let embedded = null;
  try {
    embedded = await store.embedTexts(texts);
  } catch (err) {
    console.error('[memory] candidates not embedded:', errText(err));
  }
  if (!embedded) return byWords;
  const byText = new Map(texts.map((text, i) => [text, embedded.vectors[i]]));
  const stored = vectorLookup(store);
  // A stored vector counts only while it is of the model the candidates were embedded with.
  const vectorOf = (record) => byText.get(docText(record)) || (stored && store.model() === embedded.model ? stored(record) : undefined);
  const byMeaning = candidatesFrom(answer, { ...ctx, vectorOf });
  try {
    return shieldCandidates(byMeaning, { file: rejectedVectorsPath(store.dir), model: embedded.model, vectorOf });
  } catch (err) {
    console.error('[memory] rejected-vector shield skipped:', errText(err));
    return byMeaning;
  }
}

module.exports = {
  rejectedVectorsPath,
  readRejected,
  addRejected,
  closestRejected,
  rememberRejected,
  forgetSimilar,
  shieldCandidates,
  semanticCandidates,
  REJECTED_VECTORS_FILE,
  MAX_REJECTED_VECTORS,
  REJECTED_SIMILAR,
  SIMILAR_REJECTED,
};
