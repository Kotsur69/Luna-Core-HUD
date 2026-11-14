// ============================================================================
// LunaCore - memory search: a throwaway full-text index (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, section 5 "Retrieval". Keywords are
// SQLite FTS5 through Node's built-in `node:sqlite`, so there is no native
// package to ship. Since phase 2b a search that comes with the question's
// embedding also ranks by meaning (vectors from src/memoryembed.js, compared
// in plain JS); without one it is the keyword search of phase 1, unchanged.
//
// The index lives in memory and is built from the mirror's records: there is
// no index file to go stale, and a rebuild of a few thousand small records
// takes milliseconds.
//
// Ranking: bm25 (title and tags weigh more than the body), then boosts for
// the current project, for global memories, and for confidence. A memory
// another memory of the same project supersedes is left out.
//
// The query is never passed to FTS5 as written: it is cut into words and each
// word is quoted, so search syntax in a question (AND, NEAR, quotes, a column
// name) is plain text.
// ============================================================================

'use strict';

const { GLOBAL } = require('./memoryrecord');
const { isStale, isDecayed } = require('./memoryreview');

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const MAX_TERMS = 16;
const MAX_QUERY = 500;
const SNIPPET_TOKENS = 24;
/** Matches ranked per search before the project and superseded filters cut them down. */
const MAX_CANDIDATES = 2000;

const BM25_WEIGHTS = { title: 4, tags: 2, body: 1 };
const PROJECT_BOOST = 1.5;
const GLOBAL_BOOST = 1.15;
const CONFIDENCE_BOOST = { confirmed: 1.2, observed: 1, inferred: 0.8 };
/** A gotcha or how-to nobody has verified for a long time ranks lower (phase 5). */
const STALE_FACTOR = 0.8;

// Hybrid ranking (phase 2b, src/memoryembed.js), measured on the golden set of
// 2026-11-12. The meaning of a question leads; keywords add a little, so an
// exact token (an error code, a flag) still wins. Plain rank fusion of the two
// lists was worse than either weighting below.
/** Cosine similarity of an unrelated memory; only what is above it counts. */
const COS_FLOOR = 0.3;
/** A memory no keyword matched is returned only above this similarity. */
const MIN_COS = 0.35;
const KEYWORD_WEIGHT = 0.15;
/** A query of a few bare words is a lookup of exact tokens: keywords weigh more. */
const SHORT_QUERY_TERMS = 3;
const SHORT_QUERY_KEYWORD_WEIGHT = 0.4;
const SEMANTIC_SNIPPET_CHARS = 160;

/** The distinct words of a question that are worth searching for. */
function termsOf(query) {
  if (typeof query !== 'string') return [];
  const words = query.slice(0, MAX_QUERY).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(words.filter((w) => w.length > 1))].slice(0, MAX_TERMS);
}

/** A question -> an FTS5 expression of quoted prefix terms, or null (nothing to search). */
function toMatch(query) {
  const terms = termsOf(query);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Words the id and the project carry: `gm-deps-asar-lock` should match "asar". */
function tagsOf(record) {
  return [record.id, record.type, record.area || '', record.project === GLOBAL ? GLOBAL : record.project.split('/').pop()].join(' ').replace(/[-_.]/g, ' ');
}

/**
 * @param {[string, object][]} records [key, record] from memorystore.scan()
 * @param {{vectors?: Map<string, Float32Array>|null}} [opts] vectors = one unit
 *   vector per memory key (src/memoryembed.js); read at search time, so a Map
 *   that is still being filled is fine
 * @returns {{search: Function, size: number, close: () => void}}
 */
function createIndex(records, { vectors = null } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    return buildIndex(db, records, vectors);
  } catch (err) {
    // Nobody else holds the handle yet: a failed build must not leak it.
    db.close();
    throw err;
  }
}

function buildIndex(db, records, vectors) {
  db.exec("create virtual table mem using fts5(key unindexed, title, tags, body, tokenize = 'unicode61 remove_diacritics 2')");
  const insert = db.prepare('insert into mem (key, title, tags, body) values (?, ?, ?, ?)');
  const byKey = new Map();
  const superseded = new Set();
  for (const [key, record] of records) {
    byKey.set(key, record);
    insert.run(key, record.title, tagsOf(record), record.body);
    // An unconfirmed memory only proposes to replace another one (phase 4):
    // what it names stays findable until Mati approves it.
    if (record.confidence === 'confirmed') for (const old of record.supersedes) superseded.add(`${record.project}/${old}`);
  }
  const { title, tags, body } = BM25_WEIGHTS;
  const find = db.prepare(
    `select key, bm25(mem, 0, ${title}, ${tags}, ${body}) as rank,
            snippet(mem, 3, '', '', ' ... ', ${SNIPPET_TOKENS}) as snippet
     from mem where mem match ? order by rank limit ${MAX_CANDIDATES}`,
  );

  /**
   * @param {string} query
   * @param {{project?: string|null, limit?: number, only?: string|null, today?: string|null, vector?: Float32Array|null}} [opts]
   *   project = the session's project: its memories rank higher;
   *   only = return this project's and global memories and nothing else;
   *   today = YYYY-MM-DD: an old digest is left out and a stale memory ranks
   *   lower (src/memoryreview.js). Without it, age plays no part;
   *   vector = the question's embedding: memories are ranked by meaning first
   *   and by keywords second. Without it (or without memory vectors) the
   *   ranking is keywords only.
   * @returns {object[]} best first: {key, id, project, type, title, confidence,
   *   created, last_verified, source, links, snippet, stale, score}
   */
  function search(query, { project = null, limit = DEFAULT_LIMIT, only = null, today = null, vector = null, archived = false } = {}) {
    const terms = termsOf(query);
    const semantic = Boolean(vector && vectors && vectors.size);
    if (!terms.length && !semantic) return [];
    const max = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const rows = terms.length ? find.all(toMatch(query)) : [];
    // bm25() is negative, lower is better: `rows` come best first.
    const base = semantic ? hybridScores(rows, terms.length, vector) : new Map(rows.map((row) => [row.key, -row.rank]));
    const snippets = new Map(rows.map((row) => [row.key, row.snippet]));
    const hits = [];
    for (const [key, relevance] of base) {
      const record = byKey.get(key);
      if (!record || superseded.has(key)) continue;
      // An archived memory (src/memorydecay.js) is found only when asked for.
      if (record.archived && !archived) continue;
      if (only && record.project !== only && record.project !== GLOBAL) continue;
      if (today && isDecayed(record, today)) continue;
      const stale = Boolean(today) && isStale(record, today);
      const scope = record.project === project ? PROJECT_BOOST : record.project === GLOBAL ? GLOBAL_BOOST : 1;
      hits.push({
        key,
        id: record.id,
        project: record.project,
        type: record.type,
        title: record.title,
        confidence: record.confidence,
        created: record.created,
        last_verified: record.last_verified || null,
        source: record.source || null,
        links: record.links,
        // A memory found by meaning alone has no matched words to show: its opening lines stand in.
        snippet: (snippets.get(key) ?? record.body.slice(0, SEMANTIC_SNIPPET_CHARS)).replace(/\s+/g, ' ').trim(),
        stale,
        score: relevance * scope * CONFIDENCE_BOOST[record.confidence] * (stale ? STALE_FACTOR : 1),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, max);
  }

  /**
   * key -> relevance of every memory worth returning for an embedded question:
   * similarity above the floor, plus a share of its keyword score (the best
   * keyword match counts as 1).
   */
  function hybridScores(rows, termCount, vector) {
    const best = rows.length ? -rows[0].rank : 0;
    const keyword = new Map(rows.map((row) => [row.key, best > 0 ? -row.rank / best : 0]));
    const weight = termCount <= SHORT_QUERY_TERMS ? SHORT_QUERY_KEYWORD_WEIGHT : KEYWORD_WEIGHT;
    const scores = new Map();
    for (const key of byKey.keys()) {
      const memory = vectors.get(key);
      // A vector of another size is another model's: it says nothing here.
      const cos = memory && memory.length === vector.length ? dot(vector, memory) : null;
      const matched = keyword.get(key);
      if (matched === undefined && !(cos >= MIN_COS)) continue;
      const meaning = cos === null ? 0 : Math.max(0, (cos - COS_FLOOR) / (1 - COS_FLOOR));
      scores.set(key, meaning + weight * (matched || 0));
    }
    return scores;
  }

  return { search, size: byKey.size, close: () => db.close() };
}

module.exports = { createIndex, toMatch, DEFAULT_LIMIT };
