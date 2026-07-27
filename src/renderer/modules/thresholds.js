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
