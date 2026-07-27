// ============================================================================
// LunaCore - shared renderer helpers
// ----------------------------------------------------------------------------
// Deliberately tiny. Anything bigger belongs to the module that owns it.
// ============================================================================

'use strict';

import { pickLocalized } from './localize.js';

/**
 * Translation shortcut. i18n.js is a classic <script> that sets window.i18n
 * before this module graph runs, so the global is always there by now.
 *
 * It stays a global rather than an import on purpose: i18n.js wraps itself in
 * an IIFE precisely because a top-level `const t` there once collided with the
 * renderer's own `t` and killed the whole file (SyntaxError). Leave it alone.
 */
export const t = (key, params) => window.i18n.t(key, params);

/**
 * Resolves a value authored in config/*.json to the current language.
 *
 * `t()` is for strings LunaCore ships; `loc()` is for strings the USER wrote
 * (cheat-sheets, prompts, profile and project labels). Those cannot go through
 * the dictionary - a user editing cheatsheets.local.json has no way to add
 * entries to i18n.js - so they carry their own translations inline. See
 * src/localized.js for the schema.
 *
 * Call it at RENDER time, not load time, and re-render on a language change.
 */
export const loc = (value) => pickLocalized(value, window.i18n.lang);

/** Short visual acknowledgement of a click. */
export function pulse(el) {
  el.classList.remove('is-pulsing');
  // force a reflow so the animation can restart
  void el.offsetWidth;
  el.classList.add('is-pulsing');
}
