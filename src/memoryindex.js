// ============================================================================
// LunaCore - memory search: a throwaway full-text index (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, section 5 "Retrieval". Phase 1 is
// keyword search only: SQLite FTS5 through Node's built-in `node:sqlite`, so
// there is no native package to ship. Embeddings join in phase 2, once the
// golden set can pick a model.
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

/** A question -> an FTS5 expression of quoted prefix terms, or null (nothing to search). */
function toMatch(query) {
  if (typeof query !== 'string') return null;
  const words = query.slice(0, MAX_QUERY).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const terms = [...new Set(words.filter((w) => w.length > 1))].slice(0, MAX_TERMS);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

/** Words the id and the project carry: `gm-deps-asar-lock` should match "asar". */
function tagsOf(record) {
  return [record.id, record.type, record.area || '', record.project === GLOBAL ? GLOBAL : record.project.split('/').pop()].join(' ').replace(/[-_.]/g, ' ');
}

/**
 * @param {[string, object][]} records [key, record] from memorystore.scan()
 * @returns {{search: Function, size: number, close: () => void}}
 */
function createIndex(records) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    return buildIndex(db, records);
  } catch (err) {
    // Nobody else holds the handle yet: a failed build must not leak it.
    db.close();
    throw err;
  }
}

function buildIndex(db, records) {
  db.exec("create virtual table mem using fts5(key unindexed, title, tags, body, tokenize = 'unicode61 remove_diacritics 2')");
  const insert = db.prepare('insert into mem (key, title, tags, body) values (?, ?, ?, ?)');
  const byKey = new Map();
  const superseded = new Set();
  for (const [key, record] of records) {
    byKey.set(key, record);
    insert.run(key, record.title, tagsOf(record), record.body);
    for (const old of record.supersedes) superseded.add(`${record.project}/${old}`);
  }
  const { title, tags, body } = BM25_WEIGHTS;
  const find = db.prepare(
    `select key, bm25(mem, 0, ${title}, ${tags}, ${body}) as rank,
            snippet(mem, 3, '', '', ' ... ', ${SNIPPET_TOKENS}) as snippet
     from mem where mem match ? order by rank limit ${MAX_CANDIDATES}`,
  );

  /**
   * @param {string} query
   * @param {{project?: string|null, limit?: number, only?: string|null}} [opts]
   *   project = the session's project: its memories rank higher;
   *   only = return this project's and global memories and nothing else
   * @returns {object[]} best first: {key, id, project, type, title, confidence,
   *   created, last_verified, source, links, snippet, score}
   */
  function search(query, { project = null, limit = DEFAULT_LIMIT, only = null } = {}) {
    const match = toMatch(query);
    if (!match) return [];
    const max = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const hits = [];
    for (const row of find.all(match)) {
      const record = byKey.get(row.key);
      if (!record || superseded.has(row.key)) continue;
      if (only && record.project !== only && record.project !== GLOBAL) continue;
      const scope = record.project === project ? PROJECT_BOOST : record.project === GLOBAL ? GLOBAL_BOOST : 1;
      hits.push({
        key: row.key,
        id: record.id,
        project: record.project,
        type: record.type,
        title: record.title,
        confidence: record.confidence,
        created: record.created,
        last_verified: record.last_verified || null,
        source: record.source || null,
        links: record.links,
        snippet: row.snippet.replace(/\s+/g, ' ').trim(),
        // bm25() is negative, lower is better.
        score: -row.rank * scope * CONFIDENCE_BOOST[record.confidence],
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, max);
  }

  return { search, size: byKey.size, close: () => db.close() };
}

module.exports = { createIndex, toMatch, DEFAULT_LIMIT };
