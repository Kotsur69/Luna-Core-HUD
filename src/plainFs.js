// ============================================================================
// LunaCore - the plain (non-asar) fs for deleting and walking real folders
// ----------------------------------------------------------------------------
// Electron patches `fs` so that any *.asar file reads as a virtual archive.
// A recursive delete or walk of a worktree / node_modules in the main process
// then OPENS electron/dist/resources/default_app.asar as an archive and keeps
// that handle for the life of the process: the following rmdir fails with
// EBUSY, and so does every later npm ci, rename or move of that folder.
//
// `original-fs` is Electron's unpatched fs: an .asar is just a file there.
// Under plain node (tests, scripts) there is no `original-fs`, and `fs` is
// already unpatched, so it is used as is.
// ============================================================================

'use strict';

const fs = require('fs');

/**
 * The fs to delete / walk real folders with: `original-fs` inside Electron,
 * plain `fs` everywhere else (or when original-fs cannot be loaded).
 * @param {{electron?:string}} [versions] process.versions (injectable for tests)
 * @param {(id:string) => object} [requireImpl]
 * @returns {typeof fs}
 */
function plainFs(versions = process.versions, requireImpl = require) {
  if (!versions || !versions.electron) return fs;
  try {
    return requireImpl('original-fs');
  } catch {
    return fs;
  }
}

module.exports = { plainFs };
