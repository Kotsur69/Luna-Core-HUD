// ============================================================================
// LunaCore - localized config values (renderer half)
// ----------------------------------------------------------------------------
// The picking end of the schema documented in src/localized.js:
//
//   "Git"                                  -> "Git" in every language
//   { "pl": "Testy / Build",
//     "en": "Tests / Build" }              -> whichever is current
//
// This lives in the RENDERER, not the loader, for the same reason the widget
// contract carries `titleKey` instead of `title`: the language switch is live,
// so a value resolved once at load time would freeze the HUD into the language
// it booted in. Main passes the localized object through untouched; every
// render resolves it again.
//
// Deliberately DOM-free and lang-as-an-argument so it is unit-testable - the
// bound convenience wrapper that reads window.i18n.lang is `loc()` in util.js.
// ============================================================================

'use strict';

/** UI languages, in fallback order. Mirrors LANGS in src/localized.js. */
export const LANGS = ['pl', 'en'];

/**
 * Resolves an authored config value to a display string.
 *
 * Fallback order is: the requested language, then pl, then en, then ''. That
 * matches i18n.js (a missing key falls back to PL), so a half-translated
 * config degrades to a readable string in the other language rather than to a
 * blank label - a blank would look like a broken app, the wrong language looks
 * like unfinished translation, which is what it is.
 *
 * @param {string|string[]|Object|null|undefined} value authored value
 * @param {string} lang currently active language
 * @returns {string} always a string, never null
 */
export function pickLocalized(value, lang) {
  if (value == null) return '';
  // A plain string is language-neutral: `git status`, `/compact`, `Cyberpunk`.
  if (typeof value === 'string') return value;
  // An array is an authored multi-line value that no loader flattened.
  if (Array.isArray(value)) return value.filter((l) => typeof l === 'string').join('\n');
  if (typeof value !== 'object') return String(value);

  for (const l of [lang, ...LANGS]) {
    const v = value[l];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.length) return v.filter((x) => typeof x === 'string').join('\n');
  }
  return '';
}
