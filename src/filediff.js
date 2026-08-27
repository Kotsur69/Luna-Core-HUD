// ============================================================================
// LunaCore - unified-diff line classifier for the Active-Files Heatmap's
// accumulated diff viewer (reference/ACTIVE_FILES_HEATMAP_PLAN.md
// "§ Accumulated diff viewer").
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER, same class as activefiles.js / sessiontimeline.js: the
// input is `git diff HEAD -- <file>` stdout, a local disk read run once per
// explicit user click - zero tokens, zero PTY writes, no watcher. This module
// runs no git at all; it only CLASSIFIES that already-captured text into
// per-line kinds so the renderer can colour it.
//
// Pure and import-free (gitquick-format.js's rule): it touches no global and
// no Node built-in, so it loads both in a bare `node --test` via require() and
// in the renderer as an ES module.
// ============================================================================

'use strict';

/**
 * Classifies one raw `git diff` line into a paint kind:
 *  - 'hunk' : a "@@ ... @@" hunk header
 *  - 'meta' : "diff --git", "index ", "--- ", "+++ ", "new file mode", a
 *             "\ No newline at end of file" marker, the "Binary files ... differ"
 *             sentinel, and the other file-header lines git emits
 *  - 'add'  : a "+"-prefixed added line (the "+++ " header is 'meta', not 'add')
 *  - 'del'  : a "-"-prefixed removed line (the "--- " header is 'meta', not 'del')
 *  - 'ctx'  : an unchanged context line, or anything unrecognised
 * @param {string} line
 * @returns {'hunk'|'meta'|'add'|'del'|'ctx'}
 */
export function classifyDiffLine(line) {
  const s = typeof line === 'string' ? line : '';
  if (s.startsWith('@@')) return 'hunk';
  // Order matters: the file headers are '+++'/'---' prefixed, so they must be
  // ruled out before the bare '+'/'-' add/del checks below.
  if (s.startsWith('+++') || s.startsWith('---')) return 'meta';
  if (
    s.startsWith('diff --git ') ||
    s.startsWith('index ') ||
    s.startsWith('new file mode ') ||
    s.startsWith('deleted file mode ') ||
    s.startsWith('old mode ') ||
    s.startsWith('new mode ') ||
    s.startsWith('rename from ') ||
    s.startsWith('rename to ') ||
    s.startsWith('copy from ') ||
    s.startsWith('copy to ') ||
    s.startsWith('similarity index ') ||
    s.startsWith('dissimilarity index ') ||
    s.startsWith('Binary files ') ||
    s.startsWith('GIT binary patch') ||
    s.startsWith('\\ No newline at end of file')
  ) {
    return 'meta';
  }
  if (s.startsWith('+')) return 'add';
  if (s.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * Turns raw `git diff` stdout into the shape the renderer paints:
 * `{ lines: [{ kind, text }], truncated }`.
 *
 * Splits on \n, drops the single trailing empty element left by stdout's
 * final newline (a mid-line truncation keeps its partial tail), and strips a
 * trailing \r so a CRLF checkout leaves no carriage returns in the <pre>.
 *
 * `maxChars` caps the RAW string first - diffs run much bigger than turn text,
 * and main.js applies the same ~20000 ceiling before this ever runs. Passing a
 * cap here as well is harmless and keeps the function self-contained for tests:
 * a cut that lands mid-line still classifies what survived, and `truncated` is
 * set so the modal can say so rather than ending early with no indication.
 * @param {string} stdout raw `git diff HEAD -- <file>` output
 * @param {number} [maxChars] cap on the raw text; <= 0 or omitted = no cap
 * @returns {{ lines: {kind: string, text: string}[], truncated: boolean }}
 */
export function parseDiff(stdout, maxChars = 0) {
  const raw = typeof stdout === 'string' ? stdout : '';
  let text = raw;
  let truncated = false;
  if (maxChars > 0 && raw.length > maxChars) {
    text = raw.slice(0, maxChars);
    truncated = true;
  }
  if (!text) return { lines: [], truncated };

  const parts = text.split('\n');
  // stdout ends in \n -> a trailing '' that is not a real line. A mid-line
  // truncation instead leaves a real (partial) last element, so only an exactly
  // empty tail is dropped here.
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();

  const lines = parts.map((p) => {
    const clean = p.endsWith('\r') ? p.slice(0, -1) : p;
    return { kind: classifyDiffLine(clean), text: clean };
  });
  return { lines, truncated };
}
