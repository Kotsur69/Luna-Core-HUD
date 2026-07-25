// ============================================================================
// LunaCore - shared renderer helpers
// ----------------------------------------------------------------------------
// Deliberately tiny. Anything bigger belongs to the module that owns it.
// ============================================================================

'use strict';

/**
 * Translation shortcut. i18n.js is a classic <script> that sets window.i18n
 * before this module graph runs, so the global is always there by now.
 *
 * It stays a global rather than an import on purpose: i18n.js wraps itself in
 * an IIFE precisely because a top-level `const t` there once collided with the
 * renderer's own `t` and killed the whole file (SyntaxError). Leave it alone.
 */
export const t = (key, params) => window.i18n.t(key, params);

/** Short visual acknowledgement of a click. */
export function pulse(el) {
  el.classList.remove('is-pulsing');
  // force a reflow so the animation can restart
  void el.offsetWidth;
  el.classList.add('is-pulsing');
}
