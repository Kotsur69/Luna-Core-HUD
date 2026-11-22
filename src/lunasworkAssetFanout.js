// ============================================================================
// LunaCore - luna_asset_search source:"all" helpers (pure, no I/O)
// ----------------------------------------------------------------------------
// The fan-out itself runs in src/lunasworkFreeAssets.js (search). Here:
//
//   eligibleSources  which libraries a search over all of them asks: the ones
//                    that have the requested type; a library that needs a key
//                    for search and has none stored is skipped with a note
//   withTimeout      one library that hangs must not hold up the others
//   mergeResults     the per-library results as one list: duplicates dropped
//                    (same source + id, or same name + page across libraries),
//                    CC0 first, then CC-BY, then the rest, each group by how
//                    many query words the name and tags share
// ============================================================================

'use strict';

const ALL_SOURCES = 'all';
const SKIPPED_NO_KEY = 'skipped: no key';
// A library that has not answered by then is reported as an error.
const SOURCE_TIMEOUT_MS = 30 * 1000;
// The merged list a worker reads; every library may return up to `limit` itself.
const MAX_MERGED_RESULTS = 40;
const LICENSE_RANK = Object.freeze({ cc0: 0, ccby: 1, other: 2 });

const WORD_RE = /[\p{L}\p{N}]+/gu;
const wordsOf = (text) => (typeof text === 'string' ? text.toLowerCase().match(WORD_RE) || [] : []);

/**
 * The libraries a search over all of them asks, and the ones skipped for a missing key.
 * @param {Record<string, object>} sources the clients, by id
 * @param {string[]} ids the library ids, in order
 * @param {{type?:string, hasKey:(id:string)=>boolean}} opts
 * @returns {{eligible:object[], skipped:{source:string, note:string}[]}}
 */
function eligibleSources(sources, ids, { type, hasKey }) {
  const eligible = [];
  const skipped = [];
  for (const id of ids) {
    const client = sources[id];
    if (!client || typeof client !== 'object' || typeof client.search !== 'function') continue;
    const types = Array.isArray(client.types) ? client.types : [];
    if (type !== undefined && !types.includes(type)) continue;
    const needsKey = !!(client.needsKey && client.needsKey.search === true);
    if (needsKey && !hasKey(id)) skipped.push({ source: id, note: SKIPPED_NO_KEY });
    else eligible.push(client);
  }
  return { eligible, skipped };
}

/** `promise`, or a rejection with code 'timeout' after `ms`; the timer never outlives it. */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} did not answer within ${Math.round(ms / 1000)} s`);
      err.code = 'timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function licenseRank(license) {
  if (typeof license !== 'string') return LICENSE_RANK.other;
  if (/^CC0\b/i.test(license)) return LICENSE_RANK.cc0;
  if (/^CC-BY\b/i.test(license)) return LICENSE_RANK.ccby;
  return LICENSE_RANK.other;
}

/** How many distinct query words appear in the name or tags. */
function relevance(queryWords, item) {
  const have = new Set([...wordsOf(item.name), ...(Array.isArray(item.tags) ? item.tags.flatMap(wordsOf) : [])]);
  return queryWords.filter((w) => have.has(w)).length;
}

const normName = (name) => wordsOf(name).join(' ');
const normUrl = (url) => (typeof url === 'string' ? url.trim().toLowerCase().replace(/\/+$/, '') : '');

/**
 * One ranked, deduplicated list from the per-library results.
 * @param {{source:string, id:string, name:string, license:string, url:string, tags:string[]}[]} items
 * @param {string} query
 * @param {number} [max]
 * @returns {object[]}
 */
function mergeResults(items, query, max = MAX_MERGED_RESULTS) {
  const queryWords = [...new Set(wordsOf(query))];
  const seen = new Set();
  const kept = [];
  for (const [order, item] of items.entries()) {
    const idKey = `id|${item.source}|${item.id}`;
    const name = normName(item.name);
    const url = normUrl(item.url);
    const pageKey = name && url ? `page|${name}|${url}` : null;
    if (seen.has(idKey) || (pageKey && seen.has(pageKey))) continue;
    seen.add(idKey);
    if (pageKey) seen.add(pageKey);
    kept.push({ item, order, rank: licenseRank(item.license), score: relevance(queryWords, item) });
  }
  kept.sort((a, b) => a.rank - b.rank || b.score - a.score || a.order - b.order);
  return kept.slice(0, max).map((k) => k.item);
}

module.exports = {
  ALL_SOURCES,
  SKIPPED_NO_KEY,
  SOURCE_TIMEOUT_MS,
  MAX_MERGED_RESULTS,
  eligibleSources,
  withTimeout,
  mergeResults,
  licenseRank,
  relevance,
};
