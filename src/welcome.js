// ============================================================================
// LunaCore - Getting started: when the first-run guide shows (main, pure)
// ----------------------------------------------------------------------------
// The guide (renderer modules/welcome.js) opens on a clean profile and then
// stays out of the way. Two ui.local.json keys (src/uiprefs.js) carry it:
//
//   welcomeChecked  true once this decision ran on this profile - tells "first
//                   start of a version with the guide" from every later start
//   welcomeSeen     the app version the guide was dismissed with "Don't show
//                   this again", or null
//
// Rules: an existing user (any config/*.local.json at the first start of a
// version with the guide) counts as having seen it; after that it shows again
// only when the app's major version moved past the dismissed one AND the guide
// itself changed since (GUIDE_VERSION = the app version it last changed in).
// "Major" follows semver caret rules: 0.17.x -> "0.17", 1.4.2 -> "1".
// Always reopenable from Ctrl+L, whatever this decides.
// ============================================================================

'use strict';

const fs = require('fs');

/** The app version the guide text last changed in. Bump it with the guide. */
const GUIDE_VERSION = '0.17.0';

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$/;

/** "1.2.3" -> [1, 2, 3], or null for anything else. */
function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 like a sort comparator; unparsable versions sort first. */
function compareVersions(a, b) {
  const pa = parseVersion(a) || [-1, -1, -1];
  const pb = parseVersion(b) || [-1, -1, -1];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True when `app` sits in a later caret-major line than `seen` (0.18 > 0.17, 2.0 > 1.9). */
function isMajorBump(app, seen) {
  const a = parseVersion(app);
  const s = parseVersion(seen);
  if (!a || !s) return false;
  if (a[0] !== s[0]) return a[0] > s[0];
  return a[0] === 0 && a[1] > s[1];
}

/**
 * The whole show/skip decision, from plain values.
 * @param {{appVersion:string, guideVersion?:string, seen:string|null,
 *   checked:boolean, hasLocalConfig:boolean}} input
 * @returns {'show'|'skip'|'mark-seen'} mark-seen = existing user: skip and
 *   record `seen = appVersion` so later starts never ask again
 */
function decideWelcome({ appVersion, guideVersion = GUIDE_VERSION, seen, checked, hasLocalConfig }) {
  const seenOk = parseVersion(seen) !== null;
  if (!seenOk) return !checked && hasLocalConfig ? 'mark-seen' : 'show';
  const guideChanged = compareVersions(guideVersion, seen) > 0;
  return isMajorBump(appVersion, seen) && guideChanged ? 'show' : 'skip';
}

/**
 * Whether the user config dir already holds any *.local.json - read before
 * anything of this run writes one (main asks first thing at startup).
 * @param {string} dir
 * @returns {boolean}
 */
function hasLocalConfig(dir) {
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith('.local.json'));
  } catch {
    return false;
  }
}

module.exports = { GUIDE_VERSION, decideWelcome, compareVersions, isMajorBump, parseVersion, hasLocalConfig };
