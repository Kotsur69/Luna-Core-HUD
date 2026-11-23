// ============================================================================
// LunaCore - repo documentation as searchable reference chunks (main process)
// ----------------------------------------------------------------------------
// docs/tbc_docs/RAG_STYLE_MEMORY_PLAN.md, decision 22: memory_search also finds
// what a project's own docs say, ranked below every memory (src/memoryindex.js).
//
// LOCAL ONLY. The chunks are read from the folder a project is mapped to on
// this PC and live in memory, keyed by path + mtime. They are never written to
// disk, never synced, never put on the project card, and never become memories.
//
// What is read, and only that (non-recursive):
//   README.md, CLAUDE.md, docs/reference/*.md, docs/tbc_docs/*.md
// Left out: anything with `.local.` in its name, anything under node_modules,
// files over 512 KB, and anything whose real path leaves the repo root (a
// symlink or junction cannot lead a search out of the repo).
//
// A file is cut at its `#`, `##` and `###` headings, and a section longer than
// about 1,200 characters is cut again at line breaks. Every chunk knows its
// repo-relative file and its line range, so a hit can always be opened.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 512 * 1024;
/** The most characters a chunk holds (a single longer line is cut into slices of this size). */
const MAX_CHUNK_CHARS = 1200;
/** Chunks one project contributes at most: a runaway folder cannot bloat the index. */
const MAX_CHUNKS_PER_PROJECT = 4000;
/** Cached files across all projects before the cache starts over. */
const MAX_CACHED_FILES = 600;
/** Doc files read per project: a folder of thousands of notes cannot make every search slow. */
const MAX_DOC_FILES = 200;
const DOC_DIRS = ['docs/reference', 'docs/tbc_docs'];
const ROOT_FILES = ['README.md', 'CLAUDE.md'];
const HEADING_RE = /^(#{1,3})[ \t]+(.*\S)[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;
const MD_RE = /\.md$/i;
/** A byte order mark, written as an escape so the source holds no invisible character. */
const BOM_RE = new RegExp('^' + String.fromCharCode(0xfeff));
const SKIP_NAME_RE = /\.local\./i;

/**
 * A doc chunk's memory_get key: `doc:<project>/<file>#L<start>-L<end>`, with a
 * `.<part>` suffix on the slices of one over-long line (they share a line range).
 */
const DOC_KEY_PREFIX = 'doc:';
const DOC_KEY_RE = /^doc:(.+)\/((?:README\.md|CLAUDE\.md)|docs\/(?:reference|tbc_docs)\/[^/\\]+\.md)#L(\d+)-L(\d+)(?:\.(\d+))?$/;
/** How long a project's resolved folder is reused: a search then costs no repeated repo lookups. */
const ROOT_TTL_MS = 5000;

const docKey = (project, chunk) =>
  `${DOC_KEY_PREFIX}${project}/${chunk.file}#L${chunk.startLine}-L${chunk.endLine}${chunk.part ? `.${chunk.part}` : ''}`;
const isDocKey = (key) => typeof key === 'string' && key.startsWith(DOC_KEY_PREFIX);

/** @returns {{project: string, file: string, startLine: number, endLine: number}|null} */
function parseDocKey(key) {
  const m = typeof key === 'string' ? DOC_KEY_RE.exec(key) : null;
  return m ? { project: m[1], file: m[2], startLine: Number(m[3]), endLine: Number(m[4]) } : null;
}

/** The `file#L<start>-L<end>` a hit shows as its source. */
const sourceOf = (chunk) => `${chunk.file}#L${chunk.startLine}-L${chunk.endLine}`;

/** Cuts one over-long line into slices of at most MAX_CHUNK_CHARS. */
function sliceLine(line) {
  const slices = [];
  for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) slices.push(line.slice(i, i + MAX_CHUNK_CHARS));
  return slices;
}

/**
 * Splits one section (its lines, 1-based start line) into chunks of at most MAX_CHUNK_CHARS.
 * @returns {{heading: string, startLine: number, endLine: number, text: string}[]}
 */
function splitSection(heading, lines, firstLine) {
  const chunks = [];
  let buffer = [];
  let size = 0;
  let start = firstLine;
  const flush = (endLine) => {
    const text = buffer.join('\n');
    if (text.trim()) chunks.push({ heading, startLine: start, endLine, text });
    buffer = [];
    size = 0;
  };
  lines.forEach((line, i) => {
    const lineNo = firstLine + i;
    if (line.length > MAX_CHUNK_CHARS) {
      // One huge line (a minified blob, a long table row) cannot be kept whole.
      if (buffer.length) flush(lineNo - 1);
      sliceLine(line).forEach((slice, n) => chunks.push({ heading, startLine: lineNo, endLine: lineNo, part: n + 1, text: slice }));
      start = lineNo + 1;
      return;
    }
    const added = buffer.length ? line.length + 1 : line.length;
    if (buffer.length && size + added > MAX_CHUNK_CHARS) flush(lineNo - 1);
    if (!buffer.length) start = lineNo;
    buffer.push(line);
    size += added;
  });
  if (buffer.length) flush(firstLine + lines.length - 1);
  return chunks;
}

/**
 * One markdown file -> chunks, cut at `#`, `##` and `###` headings (a `#` line
 * inside a fenced code block is not a heading).
 * @param {string} text
 * @param {string} file repo-relative path, forward slashes
 * @returns {{file: string, heading: string, startLine: number, endLine: number, text: string}[]}
 */
function chunkMarkdown(text, file) {
  const lines = String(text).replace(BOM_RE, '').split(/\r?\n/);
  // The newline that ends a file does not start another line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const fallback = path.posix.basename(file);
  const sections = [];
  let current = { heading: fallback, from: 0 };
  let fence = null;
  const close = (to) => {
    if (to > current.from) sections.push({ heading: current.heading, from: current.from, lines: lines.slice(current.from, to) });
  };
  lines.forEach((line, i) => {
    const fenced = FENCE_RE.exec(line);
    if (fenced) {
      if (!fence) fence = fenced[1];
      else if (fenced[1] === fence) fence = null;
      return;
    }
    const heading = fence ? null : HEADING_RE.exec(line);
    if (!heading) return;
    close(i);
    current = { heading: heading[2].trim(), from: i };
  });
  close(lines.length);
  return sections.flatMap((s) => splitSection(s.heading, s.lines, s.from + 1).map((c) => ({ file, ...c })));
}

/** True when `real` is `root` itself or inside it, by real paths. */
function isInside(root, real) {
  const rel = path.relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const hasNodeModules = (p) => p.split(/[\\/]/).some((seg) => seg.toLowerCase() === 'node_modules');
const isQuietError = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

/**
 * @param {{resolveRoot: (project: string) => string|null|undefined, fsImpl?: typeof fs, now?: () => number}} opts
 *   resolveRoot = the local folder a project is mapped to on this PC, or null;
 *   its answer is reused for ROOT_TTL_MS
 * @returns {{chunksFor: Function, get: Function, clear: () => void}}
 */
function createDocSource({ resolveRoot, fsImpl = fs, now = Date.now } = {}) {
  /** `<project> NUL <file> NUL <real path>` -> {mtimeMs, size, chunks}; in memory only. */
  const cache = new Map();
  /** project -> {at, root}: the resolved folder of the last few seconds. */
  const roots = new Map();

  function logFailure(what, err) {
    console.error(`[memory] docs: ${what}:`, (err && (err.code || err.message)) || 'error');
  }

  /** The doc files of one repo root as [{file, real, stat}], inside the root and under the size cap. */
  function discover(root) {
    let realRoot;
    try {
      realRoot = fsImpl.realpathSync(root);
    } catch (err) {
      if (!isQuietError(err)) logFailure('root unreadable', err);
      return [];
    }
    if (hasNodeModules(realRoot)) return [];
    const names = [...ROOT_FILES];
    for (const dir of DOC_DIRS) {
      let entries = [];
      try {
        entries = fsImpl.readdirSync(path.join(realRoot, dir));
      } catch (err) {
        if (!isQuietError(err)) logFailure(`${dir} unreadable`, err);
      }
      for (const name of entries.sort()) if (MD_RE.test(name)) names.push(`${dir}/${name}`);
    }
    names.splice(MAX_DOC_FILES);
    const found = [];
    for (const file of names) {
      if (SKIP_NAME_RE.test(path.posix.basename(file))) continue;
      try {
        const real = fsImpl.realpathSync(path.join(realRoot, file));
        if (!isInside(realRoot, real) || hasNodeModules(path.relative(realRoot, real))) continue;
        // The real file must be markdown too: a link named .md cannot expose another kind of file.
        if (SKIP_NAME_RE.test(path.basename(real)) || !MD_RE.test(real)) continue;
        const stat = fsImpl.statSync(real);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) found.push({ file, real, stat });
      } catch (err) {
        if (!isQuietError(err)) logFailure(`${file} skipped`, err);
      }
    }
    return found;
  }

  /** @returns {{chunks: object[], failed: boolean}} failed = the file could not be read this time */
  function chunksOfFile(project, { file, real, stat }) {
    const id = [project, file, real].join('\u0000');
    const hit = cache.get(id);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { chunks: hit.chunks, failed: false };
    let text;
    try {
      text = fsImpl.readFileSync(real, 'utf8');
    } catch (err) {
      if (!isQuietError(err)) logFailure(`${file} unreadable`, err);
      cache.delete(id);
      return { chunks: [], failed: true };
    }
    if (cache.size >= MAX_CACHED_FILES) cache.clear();
    const chunks = chunkMarkdown(text, file).map((c) => ({ ...c, project, key: docKey(project, c) }));
    cache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, chunks });
    return { chunks, failed: false };
  }

  /**
   * The doc chunks of a project's mapped folder; nothing when it has none.
   * `signature` changes whenever a file does, so a caller can tell if its index is stale.
   * @returns {{chunks: object[], signature: string}}
   */
  function chunksFor(project) {
    const root = rootOf(project);
    if (!root) return { chunks: [], signature: '' };
    const read = discover(root).map((f) => ({ f, ...chunksOfFile(project, f) }));
    const chunks = read.flatMap((r) => r.chunks).slice(0, MAX_CHUNKS_PER_PROJECT);
    // A file that failed to read is marked, so the index is rebuilt once it reads again.
    const signature = read.map(({ f, failed }) => `${f.file}:${f.stat.mtimeMs}:${f.stat.size}${failed ? ':unreadable' : ''}`).join('|');
    return { chunks, signature };
  }

  /** The mapped folder of a project, reused for ROOT_TTL_MS; null when there is none. */
  function rootOf(project) {
    if (typeof resolveRoot !== 'function' || typeof project !== 'string') return null;
    const at = now();
    const known = roots.get(project);
    if (known && at - known.at < ROOT_TTL_MS) return known.root;
    let root = null;
    try {
      root = resolveRoot(project);
    } catch (err) {
      logFailure('project folder not resolved', err);
    }
    root = typeof root === 'string' && root ? root : null;
    roots.set(project, { at, root });
    return root;
  }

  /** One chunk by its doc key, from the current files; null when the key is bad or the file changed since. */
  function get(key) {
    const parsed = parseDocKey(key);
    if (!parsed) return null;
    return chunksFor(parsed.project).chunks.find((c) => c.key === key) || null;
  }

  return {
    chunksFor,
    get,
    clear: () => {
      cache.clear();
      roots.clear();
    },
  };
}

module.exports = {
  createDocSource,
  chunkMarkdown,
  docKey,
  isDocKey,
  parseDocKey,
  sourceOf,
  MAX_FILE_BYTES,
  MAX_CHUNK_CHARS,
  DOC_KEY_PREFIX,
};
