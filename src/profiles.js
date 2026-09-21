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
    ccrConfig: normalizeCcrConfig(p.ccrConfig),
  };
}

/**
 * The real provider secret/endpoint for a CCR-routed profile (src/providers.js
 * buildProfileFromTemplate) - never in `env` itself, since `env` only ever
 * points `claude` at the local router, not the real provider. Returns null
 * for a direct-wired or hand-written profile.
 * @param {unknown} c
 * @returns {{providerType:string, apiKey?:string, baseUrl?:string}|null}
 */
function normalizeCcrConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const providerType = typeof c.providerType === 'string' ? c.providerType : '';
  if (!providerType) return null;
  const out = { providerType };
  if (typeof c.apiKey === 'string' && c.apiKey) out.apiKey = c.apiKey;
  if (typeof c.baseUrl === 'string' && c.baseUrl) out.baseUrl = c.baseUrl;
  return out;
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

/**
 * Strips everything a profile carries that must never reach the renderer -
 * `env` (a provider API key can be in the clear there for a direct-wired
 * profile) and `ccrConfig` (same, for a CCR-routed one) -
 * config/profiles.local.json is plaintext by design, see providers.js.
 * The renderer-side switcher only ever reads `.id`/`.label`
 * (src/renderer/modules/switchers.js); a future provider-settings UI that
 * needs to show "a key is configured" should add a boolean here, never the
 * raw value.
 * @param {Object} profile a normalizeProfile()-shaped object
 * @returns {Object}
 */
function redactProfile(profile) {
  const { env, ccrConfig, ...rest } = profile;
  return rest;
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
};
