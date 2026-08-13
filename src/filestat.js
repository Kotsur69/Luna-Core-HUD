// ============================================================================
// LunaCore - diff-stat extraction for the Active-Files Edit Heatmap
// (ACTIVE_FILES_HEATMAP_PLAN.md §3.1).
// ----------------------------------------------------------------------------
// Pure functions over the `toolUseResult` object the CLI already writes into
// the transcript (a sibling of `message`, not inside it) - no fs reads, no
// hand-rolled diff of file contents. `structuredPatch` is a unified diff the
// CLI already computed, so counting its `+`/`-` prefixed lines gives exact
// git-diff-stat numbers; `countStringDiff` only exists as a fallback for the
// (currently unobserved) case where a result carries old/new strings but no
// patch - see plan §12/R4.
// ============================================================================

'use strict';

// Guard on the LCS fallback: a 5000x5000 table on the 1.5 s watcher tick is
// not worth an exact answer nobody asked for. Above this, report the whole
// block as added/removed instead of hanging.
const MAX_DIFF_LINES = 2000;

/**
 * Sums `+`/`-` prefixed lines across every hunk of a CLI-computed unified
 * diff. Context lines (leading space) and `\ No newline at end of file`
 * markers are ignored.
 * @param {Array<{lines?: string[]}>} structuredPatch
 * @returns {{added: number, removed: number}}
 */
function countPatch(structuredPatch) {
  if (!Array.isArray(structuredPatch)) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch) {
    const lines = hunk && Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/**
 * Line count of a text blob, the way a file's line count is normally meant:
 * a file ending in a newline has N lines, not N+1.
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (!text) return 0;
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Fallback only - used when a result carries `oldString`/`newString` but no
 * `structuredPatch`. Line-level LCS, no dependency. Above MAX_DIFF_LINES on
 * either side, skips the O(n*m) table and reports the whole block as
 * added/removed rather than computing an exact but expensive diff.
 * @param {string} oldString
 * @param {string} newString
 * @returns {{added: number, removed: number}}
 */
function countStringDiff(oldString, newString) {
  const oldLines = String(oldString || '').split('\n');
  const newLines = String(newString || '').split('\n');
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return { added: newLines.length, removed: oldLines.length };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcsLength = dp[0][0];
  return { added: m - lcsLength, removed: n - lcsLength };
}

/**
 * Resolves a `{file, added, removed}` stat from a `toolUseResult` object
 * (Edit/Write/Read shapes all pass through here). Order: structuredPatch,
 * then Write's create-with-no-patch case, then the string-diff fallback,
 * then a touch-only {0,0} (a Read, or a shape we don't recognise). A failed
 * Edit writes an error *string* into `toolUseResult`, so the object-shape
 * guard naturally excludes it - a rejected edit contributes nothing.
 * @param {object|string|null|undefined} result the `toolUseResult` value
 * @returns {{file: string, added: number, removed: number}|null}
 */
function fileStatFromEntry(result) {
  if (!result || typeof result !== 'object') return null;

  const file =
    typeof result.filePath === 'string'
      ? result.filePath
      : result.file && typeof result.file.filePath === 'string'
        ? result.file.filePath
        : null;
  if (!file) return null;

  if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
    return { file, ...countPatch(result.structuredPatch) };
  }
  if (result.type === 'create' && typeof result.content === 'string') {
    return { file, added: countLines(result.content), removed: 0 };
  }
  if (typeof result.oldString === 'string' && typeof result.newString === 'string') {
    return { file, ...countStringDiff(result.oldString, result.newString) };
  }
  return { file, added: 0, removed: 0 };
}

module.exports = { countPatch, countLines, countStringDiff, fileStatFromEntry, MAX_DIFF_LINES };
