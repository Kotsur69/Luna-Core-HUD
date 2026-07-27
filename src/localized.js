// ============================================================================
// LunaCore - localized config values (main-process half)
// ----------------------------------------------------------------------------
// The i18n dictionary covers the UI chrome, but everything the user can EDIT
// lives in config/*.json - cheat-sheets, prompts, profile and project labels -
// and those rendered verbatim in whatever language they were authored in. That
// is why the English UI still showed "Review przed commitem".
//
// The schema that fixes it, without breaking a single existing config file:
//
//   "title": "Git"                                  <- language-neutral
//   "title": { "pl": "Testy / Build",
//              "en": "Tests / Build" }              <- localized
//
// A PLAIN STRING MEANS "THE SAME IN EVERY LANGUAGE". That is the important
// half: `git status`, `/compact`, `Cyberpunk` and `Luna-Core-HUD` are not
// translations waiting to happen, and any *.local.json written before this
// change keeps working untouched.
//
// This file is the MAIN-process half and deliberately cannot resolve anything:
// picking a language is a render-time decision (the switch is live, with no
// reload), exactly like `titleKey` beat `title` in the widget contract. Main
// only validates the shape, flattens authored line-arrays, and derives a stable
// merge key. The picking lives in src/renderer/modules/localize.js.
// ============================================================================

'use strict';

/** UI languages, in fallback order. First entry doubles as the merge-key pick. */
const LANGS = ['pl', 'en'];

/** Is this a localized object (as opposed to a plain, neutral value)? */
function isLocalized(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return LANGS.some((l) => l in v);
}

/**
 * Joins an authored array of lines into one string; passes anything else
 * through. Writing a multi-line prompt as an array is far more readable in
 * JSON than one string full of \n, so config may use either.
 */
function joinLines(v) {
  return Array.isArray(v) ? v.filter((l) => typeof l === 'string').join('\n') : v;
}

/** Does this value carry displayable text in at least one language? */
function hasText(v) {
  if (typeof v === 'string') return !!v.trim();
  if (!isLocalized(v)) return false;
  return LANGS.some((l) => {
    const s = joinLines(v[l]);
    return typeof s === 'string' && !!s.trim();
  });
}

/**
 * Normalizes an authored value into the shape the renderer will resolve:
 * a string stays a string, arrays are joined, and a localized object keeps its
 * shape with every language joined the same way.
 * @returns {string|Object|null} null when there is no usable text at all
 */
function normalizeText(v) {
  if (isLocalized(v)) {
    const out = {};
    for (const l of LANGS) {
      if (!(l in v)) continue;
      const joined = joinLines(v[l]);
      if (typeof joined === 'string' && joined.trim()) out[l] = joined;
    }
    return Object.keys(out).length ? out : null;
  }
  const joined = joinLines(v);
  return typeof joined === 'string' && joined.trim() ? joined : null;
}

/**
 * A stable string key for merging base config with its *.local.json override.
 *
 * Both loaders key groups by title so a local file can replace a base group.
 * A localized title is an OBJECT, and objects compare by identity in a Map -
 * every group would look unique and local overrides would silently stop
 * working. Collapsing to the first available language keeps a legacy local
 * file (`"title": "Git"`) overriding a localized base entry.
 */
function mergeKey(v) {
  if (typeof v === 'string') return v;
  if (isLocalized(v)) {
    for (const l of LANGS) {
      if (typeof v[l] === 'string' && v[l]) return v[l];
    }
  }
  return JSON.stringify(v);
}

module.exports = { LANGS, isLocalized, hasText, joinLines, normalizeText, mergeKey };
