// ============================================================================
// LunaCore - what a directory walk must never enter: build output and asar
// ----------------------------------------------------------------------------
// Electron patches Node's fs: any fs call on a path ending in .asar opens
// that file as an archive and keeps the handle for the life of the process.
// A main-process walk that stats dist/win-unpacked/resources/app.asar so
// locks it, and the next `npm run dist` fails with EBUSY on unlink.
//
// One rule for every walker that can reach a repo root: skip the build
// output folders (dist/, out/, release/) and every *.asar entry, file or
// folder (Electron reports an .asar as a directory). Walkers of non-repo
// trees (~/.claude rules and skills) use isAsarName only, so a folder that
// happens to be called "release" there is still read.
// ============================================================================

'use strict';

/** Build output folder names, compared lower-case (Windows is case-insensitive). */
const BUILD_OUTPUT_DIRS = Object.freeze(['dist', 'out', 'release']);
const BUILD_OUTPUT_SET = new Set(BUILD_OUTPUT_DIRS);
// app.asar and its sibling app.asar.unpacked folder.
const ASAR_RE = /\.asar(\.unpacked)?$/i;

/**
 * An Electron archive (or its unpacked twin), by name alone.
 * @param {unknown} name
 * @returns {boolean}
 */
function isAsarName(name) {
  return typeof name === 'string' && ASAR_RE.test(name);
}

/**
 * Should a repo walk leave this directory entry alone?
 * @param {unknown} name the entry's base name
 * @param {boolean} isDir true for a directory (build output folders count only as directories)
 * @returns {boolean}
 */
function shouldSkipEntry(name, isDir) {
  if (typeof name !== 'string' || !name) return true;
  if (isAsarName(name)) return true;
  return !!isDir && BUILD_OUTPUT_SET.has(name.toLowerCase());
}

module.exports = { BUILD_OUTPUT_DIRS, isAsarName, shouldSkipEntry };
