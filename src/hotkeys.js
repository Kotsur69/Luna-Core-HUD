// ============================================================================
// LunaCore - what a navigation chord RESOLVES TO
// ----------------------------------------------------------------------------
// The chords themselves are caught in main.js's before-input-event handler -
// the only place a keystroke can be swallowed BEFORE xterm hands it to the
// pty (see createWindow). What each chord MEANS is decided here instead, so
// "which tab is to the left" and "which project is Alt+3" can be tested
// without booting an Electron window.
//
// Pure module: no Electron, no fs, no state.
// ============================================================================

'use strict';

// Alt+1..Alt+9 address the first nine entries of config/projects.json.
// There is deliberately no Alt+0: a tenth slot on a different finger is
// worse than "use the dropdown for the rest".
const PROJECT_DIGIT_MAX = 9;

/**
 * The tab `delta` steps away from the active one, wrapping at both ends.
 *
 * Returns null - meaning "do nothing" - whenever the move is a no-op, so the
 * caller can skip the broadcast and the sound cue rather than re-activating
 * the tab that is already on screen. A single open tab is exactly that case.
 *
 * @param {string[]} ids tab ids in bar order (main.js passes the session Map's
 *   keys, whose insertion order is the order renderTabs paints)
 * @param {string|null} currentId the active tab, if any
 * @param {number} delta -1 for the tab on the left, +1 for the one on the right
 * @returns {string|null} the id to activate, or null when there is nothing to do
 */
function cycleSessionId(ids, currentId, delta) {
  if (!Array.isArray(ids) || ids.length < 2) return null;
  if (!Number.isInteger(delta)) return null;

  const at = ids.indexOf(currentId);
  // No active tab yet (or one that has already been closed): land on the
  // first rather than refusing to move at all.
  if (at === -1) return ids[0];

  const len = ids.length;
  const next = (((at + delta) % len) + len) % len;
  return next === at ? null : ids[next];
}

/**
 * Electron's KeyboardEvent.code for a top-row digit -> the digit itself.
 * NumpadN is deliberately not accepted: with NumLock off it reports as
 * ArrowLeft/ArrowRight/etc., which the tab chords above already claim.
 *
 * @param {string} code e.g. 'Digit3'
 * @returns {number|null} 1-9, or null for anything else (including 'Digit0')
 */
function parseDigitCode(code) {
  const m = /^Digit([1-9])$/.exec(code || '');
  return m ? Number(m[1]) : null;
}

/**
 * Which project a digit stands for: Alt+1 is the first entry in the list,
 * Alt+2 the second, and so on down the switcher's own order.
 *
 * @param {Array<{id?:string}>} projects normalized entries, as loaded by projects.js
 * @param {number} digit 1-9
 * @returns {string|null} the project id, or null when that slot is empty
 */
function projectIdForDigit(projects, digit) {
  if (!Array.isArray(projects)) return null;
  if (!Number.isInteger(digit) || digit < 1 || digit > PROJECT_DIGIT_MAX) return null;

  const project = projects[digit - 1];
  return project && typeof project.id === 'string' && project.id ? project.id : null;
}

/**
 * The first tab already running `projectId`, if one is open.
 *
 * This is what makes the project chords non-destructive: a jump focuses the
 * tab that is already there instead of restarting the current one, so a
 * mistyped digit can never kill a session mid-turn. Ties go to the leftmost
 * tab - deliberately not "cycle through them", which would make a single
 * chord mean two different things depending on where you already were.
 *
 * @param {Array<{id?:string, projectId?:string|null}>} entries tabs in bar order
 * @param {string} projectId
 * @returns {string|null} the tab's session id, or null when none is open
 */
function findSessionIdForProject(entries, projectId) {
  if (!Array.isArray(entries) || typeof projectId !== 'string' || !projectId) return null;

  for (const entry of entries) {
    if (!entry || entry.projectId !== projectId) continue;
    if (typeof entry.id === 'string' && entry.id) return entry.id;
  }
  return null;
}

module.exports = {
  PROJECT_DIGIT_MAX,
  cycleSessionId,
  parseDigitCode,
  projectIdForDigit,
  findSessionIdForProject,
};
