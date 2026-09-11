// ============================================================================
// LunaCore - stdout sound-trigger config loader
// ----------------------------------------------------------------------------
// Loads config/sound-triggers.json (shipped defaults, read via paths.bundled()
// same as sounds.js/theme.js/rates.js/cheatsheets.js). Holds three sibling
// pattern lists, all literal substrings matched against ANSI-stripped stdout
// via observer.js's generic detectApprovalPrompt(raw, patterns):
//   - approvalPrompt   (SOUNDS_IMPLEMENTATION_PLAN.md §3) - the y/n TUI prompt.
//   - usageLimit       (GODMODE_PLAN.md §"New pieces") - the wall God Mode has
//     to notice and wait out on its own.
//
// connectionError is still loaded, so a hand-edited config never crashes, but
// NOTHING matches it against stdout any more. A dropped request is taken from
// the CLI's transcript instead (src/observer.js, isApiErrorEntry ->
// TranscriptWatcher.onApiError -> main.js). Editing those phrases will not
// change auto-proceed's behaviour: matching the text on screen is precisely
// what used to fire "continue" at healthy sessions, because anything that
// merely PRINTED the phrase - a config dump, a grep hit, a code comment, a
// reply about the error - read as a live drop.
// Data, not code: Claude Code's TUI text can change between CLI releases, and
// Mati should be able to fix a broken match by editing JSON, not by shipping
// a new build.
//
// Missing or corrupt config resolves to empty pattern lists - detection just
// never fires, never a crash.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const BASE_FILE = paths.bundled('sound-triggers.json');

let cache = null;

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A JSON value's array-of-non-empty-strings, or []. */
function stringList(value) {
  return Array.isArray(value) ? value.filter((p) => typeof p === 'string' && p) : [];
}

/** Loads config/sound-triggers.json once; missing/corrupt file -> empty lists for all three keys. */
function loadSoundTriggers() {
  if (cache) return cache;
  const raw = readJson(BASE_FILE) || {};
  cache = {
    approvalPrompt: stringList(raw.approvalPrompt),
    usageLimit: stringList(raw.usageLimit),
    connectionError: stringList(raw.connectionError),
  };
  return cache;
}

module.exports = { loadSoundTriggers };
