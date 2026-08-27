// ============================================================================
// LunaCore - open a clicked file:line link in an external editor
// ----------------------------------------------------------------------------
// The MAIN half of the "clickable file:line links in the terminal" feature.
// The renderer detects a `src/foo.js:123` token on a terminal line and sends
// { sessionId, file, line, col } - nothing else. It never computes the
// absolute path and never builds the editor argv.
//
// §D4a compensating control: every other safe-open IPC handler (claude:docs,
// update:open-releases) takes NO argument because "never let the renderer
// supply the string". This feature must accept a renderer-supplied candidate,
// so the trade is:
//   - resolveInRoot() rejects anything that is not strictly inside that
//     session's own cwd (traversal, absolute path elsewhere, NUL byte, a
//     path that is not an existing file);
//   - buildEditorInvocation() only ever substitutes the three placeholders
//     {file} {line} {col} - no shell metacharacter handling, no string eval;
//   - main.js spawns with an args array and shell:false, so the raw renderer
//     string never reaches a shell.
//
// Both functions below are pure (buildEditorInvocation reads process.env only
// for the documented $VISUAL/$EDITOR fallback) and unit-tested in
// test/editor.test.js - same split as gpu.js's parseGpu vs. its OS wrapper.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// config/editor.json ships the default; config/editor.local.json (gitignored
// by the config/*.local.json rule) is the per-machine override. Same lazy
// local() as cheatsheets.js - this module is required before app.whenReady().
const BASE_FILE = paths.bundled('editor.json');
const localFile = () => paths.local('editor.local.json');

/** Built-in fallback when neither config file is present or readable. */
const DEFAULT_CONFIG = Object.freeze({
  command: 'code',
  args: Object.freeze(['-g', '{file}:{line}:{col}']),
});

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Loads the editor config: local overrides base, base overrides the built-in
 * default. `command` may legitimately be "" (an explicit "force the
 * $VISUAL/$EDITOR fallback"), so only a NON-STRING command is repaired.
 * @returns {{command: string, args: string[]}}
 */
function loadEditorConfig() {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(readJson(BASE_FILE) || {}),
    ...(readJson(localFile()) || {}),
  };
  if (typeof merged.command !== 'string') merged.command = DEFAULT_CONFIG.command;
  if (!Array.isArray(merged.args) || !merged.args.every((a) => typeof a === 'string')) {
    merged.args = [...DEFAULT_CONFIG.args];
  }
  return merged;
}

/**
 * Resolves a renderer-supplied candidate path against `root` and refuses
 * anything that escapes it or is not an existing file.
 *
 * @param {string} root  the session's own cwd - the only directory a link may
 *   point inside of.
 * @param {string} candidate  the raw `file` field from the renderer payload.
 * @returns {string|null} the absolute path, or null when rejected.
 */
function resolveInRoot(root, candidate) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof candidate !== 'string' || !candidate) return null;
  // A NUL byte truncates a path at the OS layer - reject outright.
  if (candidate.indexOf('\0') !== -1) return null;

  const abs = path.resolve(root, candidate);
  const rel = path.relative(root, abs);
  // rel === ''            -> candidate IS the root dir (not a file)
  // rel === '..' / '../x' -> candidate climbs out of the root
  // path.isAbsolute(rel)  -> different drive on win32 (relative() gives an abs path)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return null;
  }

  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null; // does not exist / no access
  }
  return abs;
}

/**
 * Builds the { cmd, args } to spawn for an ALREADY-RESOLVED absolute file path.
 *
 * @param {{command?: string, args?: string[]}} cfg  from loadEditorConfig().
 * @param {{file: string, line: number, col: number|null}} target
 *   `file` must already be the validated absolute path from resolveInRoot().
 * @returns {{cmd: string, args: string[]}|null}
 *   null when cfg.command is "" and neither $VISUAL nor $EDITOR is set.
 */
function buildEditorInvocation(cfg, target) {
  const { file, line, col } = target;
  const command = cfg && typeof cfg.command === 'string' ? cfg.command : DEFAULT_CONFIG.command;
  const lineStr = String(line);

  if (command) {
    const template =
      cfg && Array.isArray(cfg.args) && cfg.args.length ? cfg.args : [...DEFAULT_CONFIG.args];
    const args = template.map((raw) => {
      let out = String(raw);
      // Drop ":{col}" wholesale when there is no column, so the default
      // "{file}:{line}:{col}" degrades cleanly to "{file}:{line}".
      out = col == null ? out.replace(/:\{col\}/g, '') : out.replace(/\{col\}/g, String(col));
      out = out.replace(/\{file\}/g, file).replace(/\{line\}/g, lineStr);
      // A bare "{col}" with no preceding colon and no column -> empty.
      out = out.replace(/\{col\}/g, '');
      return out;
    });
    return { cmd: command, args };
  }

  // command === "" -> the $VISUAL / $EDITOR fallback, "+line file" convention
  // (vim, nano, emacs -nw all understand it).
  const fallback = process.env.VISUAL || process.env.EDITOR || '';
  if (!fallback) return null;
  return { cmd: fallback, args: ['+' + lineStr, file] };
}

module.exports = { loadEditorConfig, resolveInRoot, buildEditorInvocation, DEFAULT_CONFIG };
