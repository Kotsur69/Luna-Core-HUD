// ============================================================================
// LunaCore - Claude CLI effort levels for God Mode
// ----------------------------------------------------------------------------
// The CLI accepts `--effort low|medium|high|xhigh|max`. God Mode never goes
// below medium, so `low` is deliberately not a level here: anything outside
// this list is treated as "no effort chosen".
// ============================================================================

'use strict';

const EFFORTS = Object.freeze(['medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'medium';

/** @returns {boolean} true for one of the four allowed levels */
function isEffort(level) {
  return typeof level === 'string' && EFFORTS.includes(level);
}

/** The level, or null when it is not one of the allowed four. */
function normalizeEffort(level) {
  return isEffort(level) ? level : null;
}

/**
 * One step up, capped at max. An unknown level counts as the default.
 * @param {string|null|undefined} level
 * @returns {string}
 */
function nextEffort(level) {
  const i = EFFORTS.indexOf(isEffort(level) ? level : DEFAULT_EFFORT);
  return EFFORTS[Math.min(i + 1, EFFORTS.length - 1)];
}

module.exports = { EFFORTS, DEFAULT_EFFORT, isEffort, normalizeEffort, nextEffort };
