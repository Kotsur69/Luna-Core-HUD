// ============================================================================
// LunaCore - notification hub: the pure rules behind the drawer (renderer)
// ----------------------------------------------------------------------------
// No DOM, no imports - so node --test can pin them (test/hubrules.test.js):
//   - shouldAutoOpen(): whether the drawer opens by itself at launch
//     (docs/NOTIFICATION_HUB_PLAN.md Answer 1: only when unseen Needs-you
//     items exist, unless Settings say "always" or "never");
//   - normalizeAutoOpen(): a stored setting -> one of AUTO_OPEN_MODES.
// ============================================================================

'use strict';

export const AUTO_OPEN_MODES = Object.freeze(['always', 'needed', 'never']);
export const AUTO_OPEN_DEFAULT = 'needed';
/** How long after launch the first views may still open the drawer (the other PCs' rows arrive late). */
export const AUTO_OPEN_WINDOW_MS = 45 * 1000;

/** A stored auto-open setting -> a known mode (anything else is the default). */
export function normalizeAutoOpen(mode) {
  return AUTO_OPEN_MODES.includes(mode) ? mode : AUTO_OPEN_DEFAULT;
}

/**
 * Whether a view seen at launch opens the drawer. Called for each view in the
 * launch window until it says yes once; `opened` = it already did.
 * @param {{mode?: string, unseen?: number, opened?: boolean, sinceLaunchMs?: number}} input
 * @returns {boolean}
 */
export function shouldAutoOpen({ mode, unseen = 0, opened = false, sinceLaunchMs = 0 } = {}) {
  if (opened || !(sinceLaunchMs <= AUTO_OPEN_WINDOW_MS)) return false;
  const m = normalizeAutoOpen(mode);
  if (m === 'always') return true;
  if (m === 'never') return false;
  return Number.isInteger(unseen) && unseen > 0;
}
