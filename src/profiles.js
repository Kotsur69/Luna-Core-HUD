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
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'profiles.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'profiles.local.json');

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
  if (typeof p.label !== 'string' || !p.label) return null;
  // command may be empty ("" = bare shell, no auto-start) but must be a string.
  const command = typeof p.command === 'string' ? p.command : '';
  const args = Array.isArray(p.args) ? p.args.filter((a) => typeof a === 'string') : [];
  const env =
    p.env && typeof p.env === 'object' && !Array.isArray(p.env)
      ? Object.fromEntries(
          Object.entries(p.env).filter(([, v]) => typeof v === 'string')
        )
      : {};
  return { id: p.id, label: p.label, command, args, env };
}

/**
 * Loads profiles: base (profiles.json) merged with local (profiles.local.json).
 * Local may override activeProfile and add or replace profiles by id.
 * @returns {{profiles: Array, activeProfile: string}}
 */
function loadProfiles() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(LOCAL_FILE);

  // Keyed by id so local entries replace base entries with the same id.
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.profiles)) return;
    for (const raw of src.profiles) {
      const p = normalizeProfile(raw);
      if (p) byId.set(p.id, p);
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

// normalizeProfile is pure (no I/O) - exported so the tests can reach it.
module.exports = { loadProfiles, getProfile, normalizeProfile };
