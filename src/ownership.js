// ============================================================================
// LunaCore - file ownership map (docs/LUNAS_WORK_PLAN.md, idea #2 / LW 2.12)
// ----------------------------------------------------------------------------
// Before a parallel build the Director says which package owns which files:
// a repo-relative path or glob -> an owner id. Two readers share this module:
//   - lunasworkDirector.js validates the model's map strictly (any bad entry
//     rejects the whole answer)
//   - orchestraSupervisor.js matches a worker's touched files against it, so
//     God Mode can stop a worker before it clashes with another package
//
// Globs: a `**` segment = any number of folders, `*` = any run of characters
// inside one segment, `?` = one character. A plain path also owns everything
// under it when it is a folder; a trailing `/` reads as `dir/**`. Matching is
// case-insensitive (Windows repos) and never builds a RegExp from the
// model's text: the pattern is untrusted and runs in the main process on
// every file change, so a backtracking regex could freeze the app.
// Pure functions, no IO.
// ============================================================================

'use strict';

const MAX_OWNED_PATH_CHARS = 300;
const MAX_OWNERSHIP_ENTRIES = 200;
const MAX_OWNER_CHARS = 64;
const GLOB_CHARS = /[*?]/;
// Characters that would break the markdown CONTRACTS.md shows the map in.
const UNSAFE_CHARS = /[\0\r\n`|<>]/;

/**
 * A repo-relative owned path in canonical form: forward slashes, no `./`,
 * no doubled slash, a folder as `dir/**`, repeated `**` segments collapsed.
 * Null when it is absolute, escapes the repo through `..`, owns the whole
 * repo (`**`, `*`, `**\/*`), holds markdown-breaking characters, or is empty
 * / too long.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeOwnedPath(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_OWNED_PATH_CHARS || UNSAFE_CHARS.test(trimmed)) return null;
  const slashed = trimmed.replace(/\\/g, '/');
  // Posix root, UNC share, drive letter (C:, C:/) and home (~) are all outside the repo.
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed) || slashed.startsWith('~')) return null;
  const parts = slashed.split('/').filter((p) => p && p !== '.');
  if (slashed.endsWith('/')) parts.push('**');
  if (!parts.length || parts.includes('..')) return null;
  const collapsed = parts.filter((p, i) => !(p === '**' && parts[i - 1] === '**'));
  const joined = collapsed.join('/');
  return /^[*?/]+$/.test(joined) ? null : joined;
}

/**
 * One path segment against one pattern segment (`*` any run, `?` one char).
 * Greedy with a single backtrack point: O(n*m) at worst, no recursion.
 */
function segmentMatch(pat, str) {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === str[s])) {
      p += 1;
      s += 1;
    } else if (p < pat.length && pat[p] === '*') {
      star = p;
      p += 1;
      mark = s;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === '*') p += 1;
  return p === pat.length;
}

/** Pattern segments against path segments; `**` spans folders. Memoized: O(P*S) segment checks. */
function globMatch(patSegs, pathSegs) {
  const memo = new Map();
  const go = (i, j) => {
    if (i === patSegs.length) return j === pathSegs.length;
    const key = i * (pathSegs.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    const result = patSegs[i] === '**'
      ? go(i + 1, j) || (j < pathSegs.length && go(i, j + 1))
      : j < pathSegs.length && segmentMatch(patSegs[i], pathSegs[j]) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** True when the (lowercased) file falls under one compiled entry. */
function entryMatches(entry, file) {
  if (entry.exact) return file === entry.key || file.startsWith(`${entry.key}/`);
  return globMatch(entry.segs, file.split('/'));
}

/** An owner id as a string: package ids stay, card ids (numbers) become text. */
function ownerId(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id && id.length <= MAX_OWNER_CHARS ? id : null;
}

/**
 * Compiles an ownership map for matching. Accepts `{path: owner}` or
 * `[{path, owner}]`. Lenient: entries with a bad path or owner are dropped,
 * and a path seen twice (in any letter case) keeps its first owner.
 * @param {unknown} raw
 * @returns {Array<{path:string, owner:string, exact:boolean, key:string, segs:string[]}>|null} null when nothing usable
 */
function compileOwnership(raw) {
  let pairs = [];
  if (Array.isArray(raw)) pairs = raw.map((e) => (e && typeof e === 'object' ? [e.path, e.owner] : [null, null]));
  else if (raw && typeof raw === 'object') pairs = Object.entries(raw);
  const out = [];
  const seen = new Set();
  for (const [rawPath, rawOwner] of pairs.slice(0, MAX_OWNERSHIP_ENTRIES)) {
    const p = normalizeOwnedPath(rawPath);
    const owner = ownerId(rawOwner);
    const key = p ? p.toLowerCase() : null;
    if (!p || !owner || seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, owner, exact: !GLOB_CHARS.test(p), key, segs: key.split('/') });
  }
  return out.length ? out : null;
}

/**
 * Who owns a repo-relative file: an exact path (or folder) beats a glob, a
 * longer entry beats a shorter one.
 * @param {string} file
 * @param {ReturnType<typeof compileOwnership>} compiled
 * @returns {string|null} the owner id
 */
function ownerOf(file, compiled) {
  if (!Array.isArray(compiled) || typeof file !== 'string') return null;
  const target = file.toLowerCase();
  let best = null;
  for (const entry of compiled) {
    if (!entryMatches(entry, target)) continue;
    const better = !best
      || (entry.exact && !best.exact)
      || (entry.exact === best.exact && entry.path.length > best.path.length);
    if (better) best = entry;
  }
  return best ? best.owner : null;
}

module.exports = {
  MAX_OWNED_PATH_CHARS,
  MAX_OWNERSHIP_ENTRIES,
  normalizeOwnedPath,
  ownerId,
  compileOwnership,
  ownerOf,
};
