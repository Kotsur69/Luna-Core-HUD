// ============================================================================
// LunaCore - D5: is there a newer version, and may this build install it?
// ----------------------------------------------------------------------------
// NOTIFY-ONLY BY DEFAULT. Checking happens on launch; downloading never starts
// until the user asks for it. That is a deliberate product choice, not caution
// for its own sake: the release binary is UNSIGNED, so an 80 MB installer
// arriving in the background - from an app whose entire README is a promise
// about what it does and does not touch - is exactly the behaviour a stranger
// auditing this repo would be right to distrust.
//
// The same reasoning that shapes the rest of this codebase applies:
//   - the DECISION is pure and exported, so `node --test` covers every branch
//     without launching Electron (the A3 convention, see paths.js);
//   - `electron-updater` is required LAZILY by main.js, so requiring this module
//     under plain node - tests, `node --check` - never drags Electron in.
//
// The constraint that shapes everything here: A PORTABLE BUILD CANNOT UPDATE
// ITSELF. See supportsUpdates() for why that is a correctness issue and not a
// missing feature.
// ============================================================================

'use strict';

/** Where releases live. Also the page a user is sent to when we cannot self-update. */
const REPO_OWNER = 'Kotsur69';
const REPO_NAME = 'Luna-Core-HUD';

/**
 * Why a build may not update itself. Kept as codes rather than sentences so the
 * renderer can translate them - the same reason the widget contract takes
 * `titleKey` and not `title` (§A2): a string resolved here freezes the HUD into
 * one language.
 */
const REASON = {
  OK: 'ok',
  DEV: 'dev',
  PORTABLE: 'portable',
};

/**
 * Decides whether this build can install an update over itself - pure, no fs, no
 * electron, no process globals.
 *
 * Two builds genuinely cannot, and they fail for different reasons:
 *
 * DEV - running from a clone. There is no installer to run and the update path
 *   is `git pull`. electron-updater would also throw looking for a
 *   `dev-app-update.yml` that this repo deliberately does not ship.
 *
 * PORTABLE - this is the one worth stating plainly, because it looks like a
 *   missing feature and is actually a trap. `dist/latest.yml` lists ONLY
 *   `LunaCore-Setup-<version>.exe`; the portable .exe is not in it. An NSIS
 *   update works by running that installer, and a portable build has no
 *   installation to replace - so "updating" a portable copy would install a
 *   SECOND, NSIS copy of LunaCore alongside it, leaving the user running the old
 *   portable exe forever while an installed one they never asked for sits in
 *   %LOCALAPPDATA%. Refusing is the correct behaviour, and pointing at the
 *   Releases page is the honest substitute.
 *
 * @param {{isPackaged:boolean, portableDir:string|null}} env
 * @returns {{supported:boolean, reason:string}}
 */
function supportsUpdates(env) {
  const { isPackaged, portableDir } = env || {};

  if (!isPackaged) return { supported: false, reason: REASON.DEV };
  if (portableDir) return { supported: false, reason: REASON.PORTABLE };

  return { supported: true, reason: REASON.OK };
}

/**
 * Normalizes electron-updater's UpdateInfo into the little that the HUD shows.
 *
 * Defensive on purpose: this object comes off the network (parsed from
 * `latest.yml`), so every field is treated as absent-until-proven. A missing
 * version yields null rather than an "Update to undefined" pill - the same rule
 * B4 costing follows, where an unknown model produces NO estimate instead of a
 * confident wrong number.
 *
 * @param {object|null|undefined} raw
 * @returns {{version:string, releaseDate:string|null, url:string}|null}
 */
function normalizeUpdateInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!version) return null;

  const releaseDate =
    typeof raw.releaseDate === 'string' && raw.releaseDate ? raw.releaseDate : null;

  return { version, releaseDate, url: releaseUrl(version) };
}

/**
 * Canonical page for a version's notes and manual download.
 *
 * Built here in MAIN rather than taken from the renderer, for the same reason
 * the docs link is hardcoded in main.js: `shell.openExternal` on a
 * renderer-supplied string is an open redirect into the user's browser. The
 * renderer may ask to open THE release page; it cannot choose the address.
 */
function releaseUrl(version) {
  const tag = version ? `tag/v${version}` : 'latest';
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/${tag}`;
}

/** The Releases index - where a dev or portable build is sent instead. */
function releasesUrl() {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
}

/**
 * Rounds a download progress payload down to whole percent.
 *
 * Exists so the renderer is handed a number it can put straight into a scaleX
 * bar, and so a malformed or absent payload cannot produce NaN - the failure
 * mode that hid the broken ETA for three refactors (§8, the `limit` bug): NaN
 * silently takes the wrong branch instead of throwing.
 */
function progressPercent(raw) {
  const pct = raw && typeof raw.percent === 'number' ? raw.percent : null;
  if (pct === null || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.floor(pct)));
}

module.exports = {
  supportsUpdates,
  normalizeUpdateInfo,
  releaseUrl,
  releasesUrl,
  progressPercent,
  REASON,
  REPO_OWNER,
  REPO_NAME,
};
