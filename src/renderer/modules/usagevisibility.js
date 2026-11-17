// ============================================================================
// LunaCore - which usage sources the tile shows for the active tab (pure)
// ----------------------------------------------------------------------------
// The stored rule (uiprefs usageVisibility, validated in main by
// src/usagevisibility.js - mirrored here, test/usage-renderer.test.js pins the
// two) says, per tab kind, whether the Claude accounts and/or the Google
// account Antigravity runs on are listed:
//   Claude tab  default: Claude only (the tile as it always was)
//   agy tab     default: Google only
// Any other provider's tab (Codex, GLM, ...) keeps its own block only.
// No DOM and no IPC here, so every combination is unit tested.
// ============================================================================

'use strict';

/** Settings presets, in display order: id -> the rule it stands for. */
export const USAGE_PRESETS = Object.freeze({
  claude: Object.freeze({ claude: true, google: false }),
  google: Object.freeze({ claude: false, google: true }),
  all: Object.freeze({ claude: true, google: true }),
});

export const USAGE_VISIBILITY_DEFAULTS = Object.freeze({
  claudeTab: USAGE_PRESETS.claude,
  agyTab: USAGE_PRESETS.google,
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanTabRule(raw, fallback) {
  const obj = isObj(raw) ? raw : {};
  const claude = typeof obj.claude === 'boolean' ? obj.claude : fallback.claude;
  const google = typeof obj.google === 'boolean' ? obj.google : fallback.google;
  return claude || google ? { claude, google } : { ...fallback };
}

/**
 * Stored prefs value -> a complete rule set; same contract as main's
 * cleanUsageVisibility (garbage or an all-off tab rule -> that tab's default).
 * @param {unknown} raw
 */
export function normalizeUsageVisibility(raw) {
  const obj = isObj(raw) ? raw : {};
  return {
    claudeTab: cleanTabRule(obj.claudeTab, USAGE_VISIBILITY_DEFAULTS.claudeTab),
    agyTab: cleanTabRule(obj.agyTab, USAGE_VISIBILITY_DEFAULTS.agyTab),
  };
}

/** A tab rule -> its preset id ('claude' | 'google' | 'all'). */
export function presetOfRule(rule) {
  const r = cleanTabRule(rule, USAGE_PRESETS.claude);
  if (r.claude && r.google) return 'all';
  return r.google ? 'google' : 'claude';
}

/** A preset id -> its rule; an unknown id -> null (the caller keeps its value). */
export function ruleOfPreset(preset) {
  return Object.prototype.hasOwnProperty.call(USAGE_PRESETS, preset) ? { ...USAGE_PRESETS[preset] } : null;
}

const isEntry = (o) => isObj(o) && typeof o.providerId === 'string';

/** The Google (Antigravity) entry of the payload's `others`, or null. */
export function googleUsageEntry(others) {
  return (Array.isArray(others) ? others : []).find((o) => isEntry(o) && o.providerId === 'antigravity') || null;
}

/**
 * What the active tab runs, from the payload's `others` (src/providerusage.js):
 * 'agy' when the antigravity entry covers the profile (its own id or one of
 * `profileIds`), 'other' for any other provider's entry, else 'claude' (a
 * Claude tab, no tab yet, a profile we hold no reading for).
 * @param {Array<object>} others
 * @param {string|null} profileId
 * @returns {'claude'|'agy'|'other'}
 */
export function usageTabKind(others, profileId) {
  if (!profileId) return 'claude';
  const list = (Array.isArray(others) ? others : []).filter(isEntry);
  const google = googleUsageEntry(list);
  if (google && (google.profileId === profileId || (Array.isArray(google.profileIds) && google.profileIds.includes(profileId)))) {
    return 'agy';
  }
  return list.some((o) => o.profileId === profileId) ? 'other' : 'claude';
}

/**
 * Which sources the tile draws for a tab kind under the stored rule.
 * `provider` is true only on another provider's tab (its block alone).
 * Google is shown only when a Google entry exists (`hasGoogle`); a rule that
 * would leave the tile empty falls back to Claude's rows.
 * @param {'claude'|'agy'|'other'} tabKind
 * @param {unknown} prefs the stored usageVisibility
 * @param {boolean} hasGoogle whether the payload holds a Google entry
 * @returns {{claude: boolean, google: boolean, provider: boolean}}
 */
export function visibleUsageSources(tabKind, prefs, hasGoogle) {
  if (tabKind === 'other') return { claude: false, google: false, provider: true };
  const rules = normalizeUsageVisibility(prefs);
  const rule = tabKind === 'agy' ? rules.agyTab : rules.claudeTab;
  const google = rule.google && hasGoogle === true;
  return { claude: rule.claude || !google, google, provider: false };
}
