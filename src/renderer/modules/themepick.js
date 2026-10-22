// ============================================================================
// LunaCore - theme selection helpers (pure)
// ----------------------------------------------------------------------------
// No DOM, no imports: appearance.js owns the side effects, this file owns the
// two decisions worth testing from node --test.
// ============================================================================

'use strict';

/** Where a saved theme id that no longer ships lands (e.g. a removed theme). */
export const FALLBACK_THEME_ID = 'luna';

/**
 * Which theme to start on: the saved one if it still exists, else luna, else
 * whatever loaded first. Never the first entry by accident - that used to send
 * anyone on a removed theme to cyberpunk with no hint why.
 * @param {string[]} ids loaded theme ids, in picker order
 * @param {unknown} savedId the id stored in ui.local.json
 * @returns {string|null}
 */
export function pickThemeId(ids, savedId) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (typeof savedId === 'string' && ids.includes(savedId)) return savedId;
  if (ids.includes(FALLBACK_THEME_ID)) return FALLBACK_THEME_ID;
  return ids[0];
}

/**
 * The 0..1 multiplier for --effects-strength from the stored percentage.
 * Anything that is not an integer 0..100 means "as authored" (1), matching
 * the main-process validator in src/uiprefs.js.
 * @param {unknown} pct
 * @returns {number}
 */
export function effectsScale(pct) {
  return Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct / 100 : 1;
}
