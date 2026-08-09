// ============================================================================
// LunaCore - context-window thresholds (shared constants)
// ----------------------------------------------------------------------------
// Two numbers, four readers: the context bar's colour (context.js), the ETA to
// the compact zone (spark.js), armed auto-compact's trigger and re-arm points
// (autocompact.js), and the per-tab dot in the tab bar (sessions.js).
//
// They used to live in context.js, which made every one of those modules import
// a DOM-heavy module just to read two numbers - and, once context.js needed to
// import mountSpark() from spark.js for the A2 conversion, would have made a
// genuine import CYCLE between the two. That cycle would have worked only by
// accident: the threshold is read inside a function at runtime rather than at
// module-eval time. Moving that read to the top level would produce a TDZ
// ReferenceError, and the quieter failure - thresholds arriving as `undefined` -
// means a bar that never turns red and an auto-compact that never fires, with
// nothing on screen saying so.
//
// This file has no imports and touches no DOM, so it cannot take part in a cycle.
// ============================================================================

'use strict';

/** At and above this share of the window: red bar, compact warning, auto-compact. */
export const CTX_WARN_HIGH = 0.85;

/** At and above this: amber bar. Also where armed auto-compact re-arms. */
export const CTX_WARN_MID = 0.6;

/**
 * E3: which of the three bands a share falls in, as an ORDERED number.
 *
 * Ordered because the pulse fires on an UPWARD crossing only. Passing 85% is
 * news; dropping back to 40% after a compact is relief, and relief does not need
 * to grab your eye - it is already visible in the bar collapsing. Comparing band
 * NAMES would not tell you which direction you moved.
 *
 * Lives here rather than in context.js for the reason this file exists at all:
 * the usage gauge wants the same edge detection, and importing a DOM-heavy
 * module for one comparison is what created the near-cycle documented above.
 *
 * @param {number} pct 0..1
 * @returns {0|1|2} 0 = calm, 1 = mid, 2 = high
 */
export function ctxLevel(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 0;
  if (pct >= CTX_WARN_HIGH) return 2;
  if (pct >= CTX_WARN_MID) return 1;
  return 0;
}
