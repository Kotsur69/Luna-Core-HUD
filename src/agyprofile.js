// ============================================================================
// LunaCore - the Antigravity (`agy`) profile (pure apart from process.env)
// ----------------------------------------------------------------------------
// Which configured profile runs the Antigravity CLI, and the env to run it in.
// The agy counterpart of main's free-model pair: agyProfileId() mirrors
// freeProfileId() (src/orchestraFree.js pickFreeProfileId) and agyEnv()
// mirrors lunasworkFreeEnv(). God Mode worker tabs and Luna's Work headless
// jobs that run on agy get their profile and env from here; main only wires
// them in.
//
// A profile counts as agy when it was made from the 'antigravity' provider
// template (config/providers.json) or its command launches `agy` itself
// (src/launch.js isAgyCommand: agy, agy.exe, agy.cmd, any folder, any case).
// ============================================================================

'use strict';

const { isAgyCommand } = require('./launch');
const { buildSessionEnv } = require('./sessionenv');

/** config/providers.json id of the Antigravity template. */
const AGY_TEMPLATE_ID = 'antigravity';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * True for a profile that runs the Antigravity CLI.
 * @param {unknown} profile a normalized profile (src/profiles.js)
 * @returns {boolean}
 */
function isAgyProfile(profile) {
  if (!isObj(profile) || typeof profile.id !== 'string' || !profile.id) return false;
  return profile.templateId === AGY_TEMPLATE_ID || isAgyCommand(typeof profile.command === 'string' ? profile.command : '');
}

/**
 * The profile agy workers and jobs run on: `preferredId` when that one is an
 * agy profile, else the first agy profile. Null = no agy profile configured.
 * @param {object[]} profiles
 * @param {string|null} [preferredId]
 * @returns {string|null}
 */
function agyProfileId(profiles, preferredId = null) {
  const list = Array.isArray(profiles) ? profiles : [];
  const preferred = preferredId ? list.find((p) => isObj(p) && p.id === preferredId) : null;
  if (preferred && isAgyProfile(preferred)) return preferred.id;
  const first = list.find(isAgyProfile);
  return first ? first.id : null;
}

/**
 * The env an agy profile's process runs in: the inherited env minus Claude
 * session markers, with the profile's own env on top (src/sessionenv.js
 * buildSessionEnv, as for every other profile). Null for anything that is not
 * an agy profile, so a caller never starts agy in a Claude profile's env.
 * @param {unknown} profile
 * @param {{inherited?:Record<string,string>}} [opts] inherited: the base env (default process.env)
 * @returns {Record<string,string>|null}
 */
function agyEnv(profile, { inherited = process.env } = {}) {
  if (!isAgyProfile(profile)) return null;
  const own = isObj(profile.env) ? profile.env : {};
  return buildSessionEnv(inherited, own);
}

module.exports = { AGY_TEMPLATE_ID, isAgyProfile, agyProfileId, agyEnv };
