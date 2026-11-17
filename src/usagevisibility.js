// ============================================================================
// LunaCore - which usage limits the tile shows per tab kind (uiprefs key)
// ----------------------------------------------------------------------------
// usageVisibility: {claudeTab: {claude, google}, agyTab: {claude, google}}
// Settings (Ctrl+L) -> "Usage limits shown": on a Claude tab and on an
// Antigravity (agy) tab, separately, the Claude accounts and/or the Google
// account agy is signed in with. The defaults keep a Claude tab as it always
// was (Claude only) and show the Google account only on agy tabs.
//
// Main-process validator, applied on read and on write (src/uiprefs.js). The
// renderer mirrors it in src/renderer/modules/usagevisibility.js; the two are
// pinned to each other by test/usage-renderer.test.js.
// ============================================================================

'use strict';

const TAB_KINDS = Object.freeze(['claudeTab', 'agyTab']);

const USAGE_VISIBILITY_DEFAULTS = Object.freeze({
  claudeTab: Object.freeze({ claude: true, google: false }),
  agyTab: Object.freeze({ claude: false, google: true }),
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One tab kind's rule: booleans only, and never both off (that tab's default then). */
function cleanTabRule(raw, fallback) {
  const obj = isObj(raw) ? raw : {};
  const claude = typeof obj.claude === 'boolean' ? obj.claude : fallback.claude;
  const google = typeof obj.google === 'boolean' ? obj.google : fallback.google;
  return claude || google ? { claude, google } : { ...fallback };
}

/**
 * Any stored or sent value -> a complete, valid usageVisibility. Unknown
 * keys are dropped; a missing, garbage or all-off tab rule gets its default.
 * @param {unknown} raw
 * @returns {{claudeTab: {claude: boolean, google: boolean}, agyTab: {claude: boolean, google: boolean}}}
 */
function cleanUsageVisibility(raw) {
  const obj = isObj(raw) ? raw : {};
  return Object.fromEntries(TAB_KINDS.map((kind) => [kind, cleanTabRule(obj[kind], USAGE_VISIBILITY_DEFAULTS[kind])]));
}

module.exports = { USAGE_VISIBILITY_DEFAULTS, cleanUsageVisibility };
