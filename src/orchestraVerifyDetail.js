// ============================================================================
// LunaCore - God Mode v2: why a merged package's tests went red
// ----------------------------------------------------------------------------
// A red verify after a merge used to be reported by the last line of the test
// output. With node --test's spec reporter that is often the `}` closing an
// error object, so the run report said "Git said: `}`". This module pulls the
// useful part out instead:
//   - the failing tests: spec cross-mark lines (paired with their file from
//     the "failing tests:" summary when there is one) and TAP `not ok` lines,
//   - the first error line (Error: / AssertionError / SyntaxError ...),
//   - git conflict markers left in the code, with the files node named.
// Bounded: 5 names, 1 error line, 300 chars. Pure - nothing here runs anything.
// ============================================================================

'use strict';

const MAX_NAMES = 5;
const MAX_NAME_CHARS = 80;
const MAX_ERROR_CHARS = 120;
const MAX_DETAIL_CHARS = 300;
const MAX_MARKER_FILES = 5;

// The spec reporter's failure mark (U+2716), and the look-alikes other reporters print.
const CROSS_RE = /^[✖✗✕×]\s+(.+)$/;
const SUMMARY_HEAD_RE = /^[✖✗✕×]\s+failing tests:?$/i;
const NOT_OK_RE = /^not ok \d+\s*(?:-\s*)?(.*)$/;
const DIRECTIVE_RE = /\s#\s*(TODO|SKIP)\b/i;
const DURATION_RE = /\s*\(\d+(?:\.\d+)?m?s\)$/;
const TEST_AT_RE = /^test at (.+?):\d+:\d+$/;
const ERROR_RE = /^(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error\b(?:\s*\[[^\]]*\])?(?::|$)/;
const MARKER_RE = /^(<<<<<<<|>>>>>>>)(\s|$)/;
// node prints `<file>:<line>` right above the source line of a SyntaxError.
const LOCATION_RE = /^(.+\.[A-Za-z0-9]{1,8}):\d+(?::\d+)?$/;
const FILE_LIKE_RE = /^\S+\.[A-Za-z0-9]{1,8}$/;
const TIMED_OUT = '[LunaCore: verify timed out]';

const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

function cleanLines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Forward slashes, with the worktree root cut off (case-insensitive: Windows paths). */
function shortPath(file, root) {
  const s = String(file).replace(/\\/g, '/');
  const r = typeof root === 'string' && root ? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
  return r && s.toLowerCase().startsWith(r.toLowerCase()) ? s.slice(r.length) : s;
}

/** `text` with every spelling of the worktree root removed. */
function withoutRoot(text, root) {
  if (typeof root !== 'string' || !root) return text;
  const trimmed = root.replace(/[\\/]+$/, '');
  const spellings = [trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')];
  return spellings.reduce((acc, r) => acc.split(`${r}\\`).join('').split(`${r}/`).join(''), text);
}

/** The test name a failure line carries, or '' when the line is not one. */
function failName(line, root) {
  if (SUMMARY_HEAD_RE.test(line) || DIRECTIVE_RE.test(line)) return '';
  const m = CROSS_RE.exec(line) || NOT_OK_RE.exec(line);
  if (!m) return '';
  const name = m[1].replace(DURATION_RE, '').trim();
  return FILE_LIKE_RE.test(name) ? shortPath(name, root) : name;
}

const unique = (items) => [...new Set(items.filter(Boolean))];

/**
 * Failing tests. The spec reporter lists each failure twice: inline, then in
 * the "failing tests:" summary under a `test at <file>:<line>:<col>` line.
 * The summary wins when present - it names the file.
 */
function failingNames(lines, root) {
  const inline = [];
  const summary = [];
  let inSummary = false;
  let file = '';
  for (const line of lines) {
    if (SUMMARY_HEAD_RE.test(line)) {
      inSummary = true;
      continue;
    }
    const at = TEST_AT_RE.exec(line);
    if (at) {
      file = shortPath(at[1], root);
      continue;
    }
    const name = failName(line, root);
    if (!name) continue;
    if (!inSummary) inline.push(name);
    else summary.push(file && file !== name ? `${name} (${file})` : name);
  }
  return unique(summary.length ? summary : inline).map((n) => cap(n, MAX_NAME_CHARS));
}

function firstError(lines, root) {
  const line = lines.find((l) => ERROR_RE.test(l));
  return line ? cap(withoutRoot(line, root), MAX_ERROR_CHARS) : '';
}

/** null when no conflict marker is in the output, else the files node named next to one. */
function markerFiles(lines, root) {
  const files = [];
  let seen = false;
  lines.forEach((line, i) => {
    if (!MARKER_RE.test(line)) return;
    seen = true;
    const loc = i > 0 ? LOCATION_RE.exec(lines[i - 1]) : null;
    if (loc) files.push(shortPath(loc[1], root));
  });
  return seen ? unique(files).slice(0, MAX_MARKER_FILES) : null;
}

/** The last line that says something: not `}`, not node's summary counters or version. */
function lastWords(lines) {
  const said = lines.filter((l) => /[A-Za-z0-9]/.test(l) && !/^ℹ\s/.test(l) && !/^Node\.js v\d/.test(l));
  return said.length ? said[said.length - 1] : '';
}

/**
 * The useful parts of a red verify's output.
 * @param {string} output
 * @param {{root?:string}} [opts] root: the worktree, cut out of paths
 * @returns {{names:string[], error:string, markerFiles:string[]|null, timedOut:boolean, last:string}}
 *   markerFiles is null when the output holds no conflict marker
 */
function parseVerifyOutput(output, opts = {}) {
  const lines = cleanLines(output);
  return {
    names: failingNames(lines, opts.root),
    error: firstError(lines, opts.root),
    markerFiles: markerFiles(lines, opts.root),
    timedOut: lines.includes(TIMED_OUT),
    last: cap(withoutRoot(lastWords(lines), opts.root), MAX_ERROR_CHARS),
  };
}

/** As many names as fit in `budget` chars (max 5), the rest counted. */
function namesPart(names, budget) {
  const shown = [];
  for (const name of names.slice(0, MAX_NAMES)) {
    const next = [...shown, name].join(', ');
    if (shown.length && `failing: ${next} (+${names.length} more)`.length > budget) break;
    shown.push(name);
  }
  const more = names.length - shown.length;
  return `failing: ${shown.join(', ')}${more ? ` (+${more} more)` : ''}`;
}

/**
 * One line for the run report: what failed and the first error, never a
 * lone `}`. Leftover conflict markers come first - they explain everything.
 * @param {string} output verify output (stdout + stderr)
 * @param {{root?:string}} [opts]
 * @returns {string} at most 300 chars
 */
function verifyDetail(output, opts = {}) {
  const p = parseVerifyOutput(output, opts);
  const head = [];
  if (p.markerFiles) head.push(`conflict markers left in: ${p.markerFiles.length ? p.markerFiles.join(', ') : 'unknown files'}`);
  if (p.timedOut) head.push('verify timed out');
  const tail = p.error ? [p.error] : [];
  const fixed = [...head, ...tail].join('; ').length;
  const names = p.names.length ? [namesPart(p.names, MAX_DETAIL_CHARS - fixed - 2)] : [];
  const parts = [...head, ...names, ...tail];
  if (!parts.length) parts.push(p.last || 'tests failed with no output');
  return cap(parts.join('; '), MAX_DETAIL_CHARS);
}

module.exports = { verifyDetail, parseVerifyOutput, MAX_DETAIL_CHARS, MAX_NAMES };
