// ============================================================================
// LunaCore - launch profiles (Phase 4)
// ----------------------------------------------------------------------------
// Loads profile definitions from config/profiles.json (plus an optional
// config/profiles.local.json override, gitignored). A profile describes HOW to
// start a session: the command to type into the shell (e.g. "claude") and any
// environment overrides (e.g. ANTHROPIC_BASE_URL for a local LM Studio endpoint).
//
// Validate at the boundary: profiles without id/label/command are rejected. If
// the config is empty or corrupt we fall back to the built-in default profile.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText } = require('./localized');
const { slugify, uniqueId } = require('./projects');

// Shipped profiles come from the bundled root; the user's override - which is
// where API keys live, hence gitignored - lives in the WRITABLE root and is
// resolved lazily, since this module is required before app.whenReady().
// See paths.js.
const BASE_FILE = paths.bundled('profiles.json');
const localFile = () => paths.local('profiles.local.json');

// Emergency profile used when the config is missing or broken - something
// always works.
const FALLBACK = {
  activeProfile: 'claude-cloud',
  profiles: [
    { id: 'claude-cloud', label: 'Claude Cloud', command: 'claude', args: [], env: {} },
  ],
};

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // file does not exist, or is not valid JSON
  }
}

/** Validates and normalizes a single profile. Returns an object or null. */
function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !p.id) return null;
  // Label may be a string or a { pl, en } object - see src/localized.js.
  // The renderer picks the language, not the loader (the switch is live).
  if (!hasText(p.label)) return null;
  // command may be empty ("" = bare shell, no auto-start) but must be a string.
  const command = typeof p.command === 'string' ? p.command : '';
  const args = Array.isArray(p.args) ? p.args.filter((a) => typeof a === 'string') : [];
  const env =
    p.env && typeof p.env === 'object' && !Array.isArray(p.env)
      ? Object.fromEntries(
          Object.entries(p.env).filter(([, v]) => typeof v === 'string')
        )
      : {};
  // autoModel: opt in to having ANTHROPIC_MODEL filled from whatever model the
  // profile's LOCAL endpoint currently has loaded (src/lmstudio.js). Opt-in per
  // profile rather than inferred from the base URL, because "point at a local
  // server" and "let LunaCore choose the model" are separate decisions - a
  // profile can legitimately want the first without the second.
  //
  // templateId: which config/providers.json template this profile was
  // generated from (src/providers.js buildProfileFromTemplate), or null for a
  // hand-written profile. Lets the Settings UI show "GLM (Z.ai)" as an
  // editable provider card instead of a raw env blob, and re-derive the same
  // env shape if the user changes the model/key later.
  return {
    id: p.id,
    label: normalizeText(p.label),
    command,
    args,
    env,
    autoModel: p.autoModel === true,
    templateId: typeof p.templateId === 'string' && p.templateId ? p.templateId : null,
  };
}

/**
 * Loads profiles: base (profiles.json) merged with local (profiles.local.json).
 * Local may override activeProfile and add or replace profiles by id.
 * @returns {{profiles: Array, activeProfile: string}}
 */
function loadProfiles() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(localFile());

  // Ids the user deleted via the UI. Needed because a deleted entry may come
  // from the READ-ONLY base file (config/profiles.json) - removeProfile()
  // cannot erase it there, so it records the id here instead and every load
  // filters it back out. Mirrors src/projects.js's removedIds exactly.
  const removed = new Set(
    local && Array.isArray(local.removedIds) ? local.removedIds : []
  );

  // Keyed by id so local entries replace base entries with the same id.
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.profiles)) return;
    for (const raw of src.profiles) {
      const p = normalizeProfile(raw);
      if (p && !removed.has(p.id)) byId.set(p.id, p);
    }
  };
  collect(base);
  collect(local);

  let profiles = [...byId.values()];
  if (profiles.length === 0) profiles = [...FALLBACK.profiles];

  // activeProfile precedence: local > base > first available.
  let activeProfile =
    (local && typeof local.activeProfile === 'string' && local.activeProfile) ||
    (typeof base.activeProfile === 'string' && base.activeProfile) ||
    profiles[0].id;
  // Make sure the named active profile actually exists.
  if (!byId.has(activeProfile)) activeProfile = profiles[0].id;

  return { profiles, activeProfile };
}

/** Returns the profile with the given id, or null. */
function getProfile(profiles, id) {
  return profiles.find((p) => p.id === id) || null;
}

// A template's own FIXED, non-secret placeholder for ANTHROPIC_AUTH_TOKEN
// (config/providers.json's lm-studio entry, and the LEGACY value a
// CCR-routed profile created before the ccrConfig reshape still carries) -
// never a real credential, so it must not count as "a key is configured" for
// the provider-settings UI. 'ccr-local' stays here even though no shipped
// template writes it anymore: an existing profiles.local.json entry from
// before the reshape still has env.ANTHROPIC_AUTH_TOKEN === 'ccr-local' and
// must keep reporting hasApiKey: false until the user re-edits it with a
// real CCR client key (see isLegacyCcrProfile() below).
const NON_SECRET_AUTH_TOKENS = new Set(['lmstudio', 'ccr-local']);

/**
 * Strips userinfo (`user:pass@`) and any query/hash from a URL string -
 * defense in depth for the `baseUrl` exposure in redactProfile() below, even
 * though no shipped template currently embeds a secret in a URL.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const withoutUserinfo = raw.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/?#@]*@/, '$1');
  return withoutUserinfo.split(/[?#]/)[0];
}

/**
 * Strips the one field this codebase treats as secret-bearing - `env` (a
 * provider API key, and for a template-generated profile a CCR client key,
 * can be in the clear there) - config/profiles.local.json is plaintext by
 * design, see providers.js. In its place, exposes only non-secret facts
 * DERIVED from it: the current `model`/`fastModel`/`baseUrl` (so the
 * provider-settings edit form can prefill the real value instead of
 * silently resetting it to the template default on save) and
 * `hasApiKey`/`hasBaseUrl` booleans (so the UI can show "a key is
 * configured" without the raw value ever crossing IPC), and `isLegacyCcr`
 * (see isLegacyCcrProfile() below) so the UI can flag a profile that still
 * needs a real CCR client key pasted in.
 *
 * `baseUrl` is only ever read out for a TEMPLATE-generated profile
 * (`templateId` non-null) - every shipped template's envTemplate is
 * shipped/code-reviewed and provably cannot embed a secret in the URL, but a
 * hand-written profiles.local.json entry legitimately could (e.g. a URL with
 * an API key in the query string), so it stays hidden for those.
 *
 * `command`/`args` pass through UNREDACTED: every shipped template
 * (providers.js) and every shipped profile (config/profiles.json) puts all
 * provider config in `env` and always ships `args: []`, so neither field is
 * expected to ever carry a secret. A hand-written profiles.local.json entry
 * that puts one there anyway (e.g. `args: ['--api-key=...']`) would leak it
 * to the renderer - do not add secret material to `command`/`args` in a
 * profile.
 * @param {Object} profile a normalizeProfile()-shaped object
 * @returns {Object}
 */
function redactProfile(profile) {
  const { env, ...rest } = profile;
  const model = (env && typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL) || '';
  const fastModel =
    (env && typeof env.ANTHROPIC_SMALL_FAST_MODEL === 'string' && env.ANTHROPIC_SMALL_FAST_MODEL) || '';
  const hasApiKey = Boolean(
    env &&
      typeof env.ANTHROPIC_AUTH_TOKEN === 'string' &&
      env.ANTHROPIC_AUTH_TOKEN &&
      !NON_SECRET_AUTH_TOKENS.has(env.ANTHROPIC_AUTH_TOKEN)
  );
  const baseUrl =
    profile.templateId !== null && env && typeof env.ANTHROPIC_BASE_URL === 'string'
      ? sanitizeBaseUrl(env.ANTHROPIC_BASE_URL)
      : '';
  const hasBaseUrl = Boolean(baseUrl);
  return { ...rest, model, fastModel, hasApiKey, hasBaseUrl, baseUrl, isLegacyCcr: isLegacyCcrProfile(profile) };
}

/**
 * True for a profile created before the ccrConfig reshape: it still carries
 * the fixed legacy sentinel in env.ANTHROPIC_AUTH_TOKEN rather than a real
 * CCR client key. Used by the Settings UI to show a "needs your CCR client
 * key" badge and prompt a re-edit.
 * @param {{env?:Object}|null|undefined} profile
 * @returns {boolean}
 */
function isLegacyCcrProfile(profile) {
  return Boolean(profile && profile.env && profile.env.ANTHROPIC_AUTH_TOKEN === 'ccr-local');
}

/**
 * Adds one profile to profiles.local.json (creating it if missing) and
 * returns the freshly reloaded { profiles, activeProfile } - same shape as
 * loadProfiles(). Mirrors src/projects.js's addProject(): the id is derived
 * from the label when not given, de-duplicated against every existing
 * profile (base + local), and activeProfile is never touched here - adding a
 * provider must not silently switch the caller's tab away.
 * @param {{id?:string, label:string, command?:string, args?:string[],
 *   env?:Object, autoModel?:boolean, templateId?:string}} entry
 * @returns {{profiles, activeProfile, addedId:string}|null} null when
 *   `label` is missing/blank.
 */
function addProfile(entry) {
  if (!entry || !hasText(entry.label)) return null;

  const current = loadProfiles();
  const existingIds = new Set(current.profiles.map((p) => p.id));
  // A caller-supplied id (e.g. a provider's own templateId, so "kimi" stays
  // "kimi" rather than a random slug of its label) is honored only when it is
  // already a safe id-shaped string; anything else is re-derived from the
  // label, same as when no id is given at all.
  const safeSuppliedId =
    typeof entry.id === 'string' && /^[a-z0-9-]+$/i.test(entry.id) ? entry.id : '';
  const id =
    safeSuppliedId && !existingIds.has(safeSuppliedId)
      ? safeSuppliedId
      : uniqueId(slugify(safeSuppliedId || titleTextOf(entry.label)), existingIds);

  const local = readJson(localFile()) || {};
  const list = Array.isArray(local.profiles) ? local.profiles.slice() : [];
  list.push({ ...entry, id });

  paths.ensureUserDir();
  fs.writeFileSync(
    localFile(),
    JSON.stringify({ ...local, profiles: list }, null, 2) + '\n',
    'utf8'
  );

  return { ...loadProfiles(), addedId: id };
}

/**
 * Replaces one profile's definition (by id) in profiles.local.json - used
 * when the user edits an existing provider's model or key. Works for both a
 * local-only entry (overwritten in place) and one that only exists in the
 * read-only base file (a full local override is written, same as if the
 * user had "added" it under that id - loadProfiles()'s byId merge then
 * prefers the local copy).
 * @param {string} id
 * @param {Object} patch fields to merge onto the CURRENT merged profile
 * @returns {{profiles, activeProfile}|null} null when `id` does not exist
 */
function updateProfile(id, patch) {
  if (typeof id !== 'string' || !id) return null;
  const current = getProfile(loadProfiles().profiles, id);
  if (!current) return null;

  const local = readJson(localFile()) || {};
  const list = Array.isArray(local.profiles) ? local.profiles.filter((p) => p && p.id !== id) : [];
  list.push({ ...current, ...patch, id });

  paths.ensureUserDir();
  fs.writeFileSync(
    localFile(),
    JSON.stringify({ ...local, profiles: list }, null, 2) + '\n',
    'utf8'
  );

  return loadProfiles();
}

/**
 * Removes one profile by id and returns the freshly reloaded
 * { profiles, activeProfile }. Mirrors src/projects.js's removeProject():
 * a local-only entry is dropped from profiles.local.json's `profiles` array;
 * a shipped base entry's id is recorded in `removedIds` instead, since the
 * base file itself is never touched.
 * @param {string} id
 * @returns {{profiles, activeProfile}|null} null when `id` is missing/blank.
 */
function removeProfile(id) {
  if (typeof id !== 'string' || !id) return null;

  const local = readJson(localFile()) || {};
  const list = Array.isArray(local.profiles) ? local.profiles.filter((p) => p && p.id !== id) : [];
  const removedIds = new Set(Array.isArray(local.removedIds) ? local.removedIds : []);
  removedIds.add(id);

  paths.ensureUserDir();
  fs.writeFileSync(
    localFile(),
    JSON.stringify({ ...local, profiles: list, removedIds: [...removedIds] }, null, 2) + '\n',
    'utf8'
  );

  return loadProfiles();
}

/** Plain text out of a label (string or {pl,en}) for slugifying - prefers en. */
function titleTextOf(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object') return label.en || label.pl || '';
  return '';
}

// normalizeProfile/getProfile/redactProfile are pure (no I/O) - exported so
// the tests can reach them. addProfile/updateProfile/removeProfile do real
// file I/O (write profiles.local.json) and are covered by the manual
// checklist instead, same as loadProfiles() itself and projects.js's
// addProject/removeProject.
module.exports = {
  loadProfiles,
  getProfile,
  normalizeProfile,
  redactProfile,
  addProfile,
  updateProfile,
  removeProfile,
  isLegacyCcrProfile,
  NON_SECRET_AUTH_TOKENS,
};
