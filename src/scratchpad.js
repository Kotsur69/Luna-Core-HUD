// ============================================================================
// LunaCore - local scratchpad
// ----------------------------------------------------------------------------
// A notepad on the side of the session: pasted snippets, TODOs for later,
// fragments of Claude's responses. Kept as a plain text file so it can be
// opened/grepped outside the app.
//
// The file is in .gitignore (its content is private notes, not for the repo).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

// Private notes are per-machine state, so the file lives in the WRITABLE
// directory: in a dev clone that is still the repo's config/, in a packaged
// build it is %APPDATA%/LunaCore/config (or the folder next to the .exe in the
// portable version). The path is resolved on every call, since this module is
// required before app.whenReady().
const file = () => paths.local('scratchpad.local.md');

// Upper bound on the write size: the scratchpad is a notepad, not a file store.
// Guards against accidentally pasting a dozen-odd MB into the panel.
const MAX_BYTES = 256 * 1024;

/** Returns the scratchpad content; an empty string when the file does not exist yet. */
function readScratchpad() {
  try {
    return fs.readFileSync(file(), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Writes the scratchpad content (validation at the boundary: type + size).
 * @param {string} text
 * @returns {boolean} whether the write succeeded
 */
function writeScratchpad(text) {
  if (typeof text !== 'string') return false;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return false;
  try {
    paths.ensureUserDir();
    fs.writeFileSync(file(), text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { readScratchpad, writeScratchpad, MAX_BYTES };
