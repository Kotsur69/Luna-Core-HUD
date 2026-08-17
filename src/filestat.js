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
//
// PER-FILE CONTEXT WEIGHT (LUNA_HUD_ADVANCED_SPEC.md §2). A Read's result
// carries `file.content`: the exact text the CLI placed in the context window.
// That string is a better measure of what a file cost than its size on disk, in
// two ways that matter - a partial read (offset + limit) charges only the slice
// actually pasted, and a file read three times charges three times, which is
// the truth and usually the surprise.
//
// ONLY READ COUNTS. Write's `content` is what the MODEL produced, so it was
// output tokens rather than context weight; an Edit's result is a short
// confirmation snippet, and its `originalFile` is CLI bookkeeping that never
// reaches the model. Counting either would overstate things badly -
// `originalFile` alone would charge a whole file for a one-line edit.
// ============================================================================

'use strict';

// Guard on the LCS fallback: a 5000x5000 table on the 1.5 s watcher tick is
// not worth an exact answer nobody asked for. Above this, report the whole
// block as added/removed instead of hanging.
const MAX_DIFF_LINES = 2000;

/**
 * Characters per token, by kind of file.
 *
 * THIS IS AN ESTIMATE, and the HUD has to say so wherever it shows the result.
 * Everything else in LunaCore reports token counts the API itself returned
 * (`message.usage`), which are exact; there is no per-tool-result breakdown in
 * that data, so a per-file number cannot be. Mixing an exact gauge with an
 * estimated breakdown is only honest if the estimate is labelled - hence the
 * `≈` the widget prints, and the exact character count in the row's tooltip.
 *
 * Code tokenizes denser than prose: punctuation, indentation and camelCase all
 * split. ~3.6 for source, ~4.0 for prose is the usual working range.
 */
const CHARS_PER_TOKEN_CODE = 3.6;
const CHARS_PER_TOKEN_PROSE = 4.0;

// Extensions whose contents read like prose rather than source.
const PROSE_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);

/**
 * Rough token count for a blob of file text.
 * @param {number} chars length of the text that entered the context window
 * @param {string} [file] path, used only to pick a ratio
 * @returns {number} estimated tokens, rounded
 */
function estimateTokens(chars, file = '') {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const dot = String(file).lastIndexOf('.');
  const ext = dot > 0 ? String(file).slice(dot).toLowerCase() : '';
  const ratio = PROSE_EXT.has(ext) ? CHARS_PER_TOKEN_PROSE : CHARS_PER_TOKEN_CODE;
  return Math.round(n / ratio);
}

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

  // Only a Read pastes file text into the context window - see the header.
  const contextChars =
    result.file && typeof result.file.content === 'string' ? result.file.content.length : 0;

  if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
    return { file, ...countPatch(result.structuredPatch), contextChars };
  }
  if (result.type === 'create' && typeof result.content === 'string') {
    return { file, added: countLines(result.content), removed: 0, contextChars };
  }
  if (typeof result.oldString === 'string' && typeof result.newString === 'string') {
    return { file, ...countStringDiff(result.oldString, result.newString), contextChars };
  }
  return { file, added: 0, removed: 0, contextChars };
}

module.exports = {
  countPatch,
  countLines,
  countStringDiff,
  fileStatFromEntry,
  estimateTokens,
  MAX_DIFF_LINES,
};
