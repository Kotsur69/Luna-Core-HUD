// ============================================================================
// LunaCore - stdout sound-trigger config loader
// ----------------------------------------------------------------------------
// Loads config/sound-triggers.json (shipped defaults, read via paths.bundled()
// same as sounds.js/theme.js/rates.js/cheatsheets.js). Right now this only
// holds the approval-prompt patterns (SOUNDS_IMPLEMENTATION_PLAN.md §3) -
// literal substrings matched against ANSI-stripped stdout in
// observer.js's detectApprovalPrompt(). Data, not code: Claude Code's TUI text
// can change between CLI releases, and Mati should be able to fix a broken
// match by editing JSON, not by shipping a new build.
//
// Missing or corrupt config resolves to an empty pattern list - detection
// just never fires, never a crash.
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

/** Loads config/sound-triggers.json once; missing/corrupt file -> empty {approvalPrompt: []}. */
function loadSoundTriggers() {
  if (cache) return cache;
  const raw = readJson(BASE_FILE);
  cache = {
    approvalPrompt: Array.isArray(raw && raw.approvalPrompt)
      ? raw.approvalPrompt.filter((p) => typeof p === 'string' && p)
      : [],
  };
  return cache;
}

module.exports = { loadSoundTriggers };
