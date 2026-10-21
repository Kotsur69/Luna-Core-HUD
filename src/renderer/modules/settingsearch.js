// ============================================================================
// LunaCore - Settings overlay (Ctrl+L): pure search + navigation logic
// ----------------------------------------------------------------------------
// Split out of settingsnav.js so it can be unit-tested with a plain
// `require()` - same reason gitquick-format.js exists next to gitquick.js.
// This file imports NOTHING and touches no global, so it is always safe to
// load in a bare Node test.
//
// Matching is accent- and case-insensitive ("glosnosc" finds "Głośność" and
// vice versa), and every whitespace-separated token of the query has to occur
// somewhere in the haystack, in any order.
// ============================================================================

'use strict';

// Polish letters that NFD does not decompose into base + combining mark.
const FOLD = { 'ł': 'l', 'Ł': 'l' };

/** Folds one character to its search form (lowercase, no diacritics). */
function foldChar(ch) {
  if (FOLD[ch]) return FOLD[ch];
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Lowercases, strips diacritics and collapses whitespace runs to one space. */
export function normalizeSearchText(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += foldChar(ch);
  return out.replace(/\s+/g, ' ').trim();
}

/** Splits a query into normalized, de-duplicated tokens; '' -> []. */
export function tokenizeQuery(query) {
  const norm = normalizeSearchText(query);
  if (!norm) return [];
  return [...new Set(norm.split(' '))];
}

/** True when every token of `query` occurs in `haystack` (strings or arrays of strings). */
export function matchesQuery(haystack, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return true;
  const hay = normalizeSearchText(Array.isArray(haystack) ? haystack.join(' ') : haystack);
  return tokens.every((tok) => hay.includes(tok));
}

/**
 * Character ranges of `text` that match any query token, as sorted, merged
 * [start, end) pairs in ORIGINAL-string indices - what a DOM Range wants.
 * Normalization runs per character (no whitespace collapsing here) so an index
 * in the folded string maps straight back to the source.
 */
export function findMatchRanges(text, query) {
  const tokens = tokenizeQuery(query);
  const src = String(text ?? '');
  if (!tokens.length || !src) return [];

  let folded = '';
  const map = []; // folded index -> source index
  for (let i = 0; i < src.length; i++) {
    const f = foldChar(src[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }

  const ranges = [];
  for (const tok of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(tok, from);
      if (at < 0) break;
      ranges.push([map[at], map[at + tok.length - 1] + 1]);
      from = at + tok.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], r[1])];
    else merged.push(r);
  }
  return merged;
}

/**
 * Filters the overlay's groups for one query.
 *
 * `groups` is [{ title, items }] where `title` and each item are a string or an
 * array of strings (every language's text for that element). A group whose
 * title matches keeps all its items - searching "LM Studio" should show the
 * whole section, not just the rows that repeat the name.
 *
 * Returns null for an empty query (no filtering), otherwise
 * { groups: [{ index, titleMatch, items: [itemIndex, ...] }], count }, listing
 * only the groups with at least one hit; `count` is the number of hits.
 */
export function filterSettings(groups, query) {
  if (!tokenizeQuery(query).length) return null;
  const out = [];
  let count = 0;
  (groups || []).forEach((group, index) => {
    const items = group.items || [];
    const titleMatch = matchesQuery(group.title || '', query);
    const visible = titleMatch
      ? items.map((_, i) => i)
      : items.flatMap((item, i) => (matchesQuery(item, query) ? [i] : []));
    // A matching title with no items still counts - the heading alone is a hit.
    if (!visible.length && !titleMatch) return;
    out.push({ index, titleMatch, items: visible });
    count += Math.max(visible.length, 1);
  });
  return { groups: out, count };
}

/**
 * Next selected index in the vertical category rail for one key, wrapping at
 * the ends. Returns -1 for any key the rail does not handle.
 */
export function moveNavIndex(current, key, count) {
  if (!count) return -1;
  const cur = Number.isInteger(current) && current >= 0 && current < count ? current : 0;
  if (key === 'ArrowDown') return (cur + 1) % count;
  if (key === 'ArrowUp') return (cur - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
